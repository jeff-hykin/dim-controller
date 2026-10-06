// Camera panels: one by default (the profile's preferred camera), more on demand. Any panel can take over the
// screen, which shrinks the 3D view into a picture-in-picture. Depth is drawn as a colormap; 2D detections can be
// overlaid on any panel.
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { type Store, useStore } from "../core/store.ts"
import { parseKey, type Topic } from "../core/transport.ts"
import { isDepthTopic } from "../core/video.ts"
import { overlayTypeFor } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { DEFAULT_DEPTH_LOOK, DEPTH_COLORMAPS, DepthCanvas, type DepthLook } from "../core/render/depth.ts"
import { Icon } from "./icons.tsx"
import { presetFor, QUALITY_PRESETS, readLocal, type VideoQuality, writeLocal } from "../core/videoQuality.ts"

export interface PanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** overlay topic key ("" = none) */
    overlay: string
    x: number
    y: number
    width: number
    height: number
    /** the user resized it: keep that size (else it fits the image's aspect) */
    sized?: boolean
    /** got the default size once (panels saved before 2026-10-05 have neither flag: they start over at the default) */
    fitted?: boolean
    /** depth topics: colormap and fixed range (null = auto) */
    depth?: DepthLook
}

export interface CameraLayout {
    panels: PanelState[]
    /** the panel shown fullscreen (the 3D view becomes a picture-in-picture), or null */
    main: number | null
    /** a panel was opened on the first camera once (closing it all stays closed) */
    seeded?: boolean
    /** the camera is main because nothing draws in 3D (no point cloud): a cloud showing up gives the view back */
    auto?: boolean
    /** the panel that was opened for that (closed again with it) */
    autoPanel?: number | null
}

/** a lidar / point cloud: what makes the 3D view worth the screen */
export const isCloudTopic = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2" || /lidar/i.test(topic.name)

/** the user swapped the layout themselves this session: the camera-only default leaves it alone */
let userChoseLayout = false
export function chooseLayout() {
    userChoseLayout = true
}

/** how long the topic list has to stay the same before a camera-only blueprint gets the camera layout (topics arrive one by one) */
const SETTLE_MS = 3000

const isImage = (topic: Topic) => topic.type === "sensor_msgs.Image" || topic.type === "sensor_msgs.CompressedImage"

function pickDefault(app: ViewerApp, topics: Topic[]): Topic | null {
    const images = topics.filter(isImage)
    for (const name of app.profile.cameras.preferred) {
        const found = images.find((topic) => topic.name === name)
        if (found) {
            return found
        }
    }
    return images.find((topic) => !isDepthTopic(topic)) ?? images[0] ?? null
}

/** The camera header's height: a panel is this plus the image. */
const HEAD_PX = 33
/** The size before the image's is known (and for panels saved at the old 360×240 default): ~38% of the window, 16:9. */
function defaultSize() {
    const width = Math.round(Math.max(320, Math.min(760, (globalThis.innerWidth || 1280) * 0.38)))
    return { width, height: Math.round(width * 9 / 16) + HEAD_PX }
}

export function CameraPanels({ app, layout, mobile }: { app: ViewerApp; layout: Store<CameraLayout>; mobile: boolean }) {
    const { panels, main, seeded } = useStore(layout)
    const { topics } = useStore(app.connection.status)

    // the first time a camera shows up, open exactly one panel on it
    useEffect(() => {
        if (panels.length || seeded) {
            return
        }
        const first = pickDefault(app, topics)
        if (first) {
            layout.update({ seeded: true, panels: [{ id: 1, key: first.key, overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
        }
    }, [topics, panels.length, seeded, app, layout])

    // camera-only (no point cloud, a camera): the camera fills the screen and the 3D view becomes the picture-in-picture
    const topicKeys = topics.map((topic) => topic.key).join("|")
    useEffect(() => {
        const clouds = topics.some(isCloudTopic)
        const current = layout.get()
        if (clouds) {
            if (current.auto) {
                const panels = current.autoPanel ? current.panels.filter((panel) => panel.id !== current.autoPanel) : current.panels
                layout.update({ main: null, auto: false, autoPanel: null, panels })
            }
            return
        }
        if (current.main !== null || userChoseLayout || !topics.some(isImage)) {
            return
        }
        const timer = setTimeout(() => {
            const latest = app.connection.status.get().topics
            const now = layout.get()
            if (latest.some(isCloudTopic) || now.main !== null || userChoseLayout) {
                return
            }
            const camera = now.panels.find((panel) => latest.some((topic) => topic.key === panel.key && isImage(topic)))
            if (camera) {
                layout.update({ main: camera.id, auto: true })
                return
            }
            const first = pickDefault(app, latest)
            if (first) {
                const id = Math.max(0, ...now.panels.map((panel) => panel.id)) + 1
                layout.update({ seeded: true, auto: true, autoPanel: id, main: id, panels: [...now.panels, { id, key: first.key, overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
            }
        }, SETTLE_MS)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topicKeys, app, layout])

    const update = (id: number, patch: Partial<PanelState>) => layout.update({ panels: layout.get().panels.map((panel) => panel.id === id ? { ...panel, ...patch } : panel) })
    const close = (id: number) => {
        const current = layout.get()
        const wasMain = current.main === id
        if (wasMain) {
            chooseLayout()
        }
        layout.update({ panels: current.panels.filter((panel) => panel.id !== id), main: wasMain ? null : current.main, auto: wasMain ? false : current.auto, autoPanel: current.autoPanel === id ? null : current.autoPanel })
    }
    const add = () => {
        const used = new Set(panels.map((panel) => panel.key))
        const next = topics.filter(isImage).find((topic) => !used.has(topic.key)) ?? pickDefault(app, topics)
        const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
        layout.update({ panels: [...panels, { id, key: next?.key ?? "", overlay: "", x: -1, y: -1, ...defaultSize(), fitted: true }] })
    }

    return (
        <div className="camera-layer">
            {panels.map((panel, index) => (
                <CameraPanel
                    key={panel.id}
                    app={app}
                    panel={panel}
                    index={index}
                    topics={topics}
                    isMain={main === panel.id}
                    mobile={mobile}
                    onChange={(patch) => update(panel.id, patch)}
                    onClose={() => close(panel.id)}
                    onMain={() => {
                        chooseLayout()
                        layout.update({ main: main === panel.id ? null : panel.id, auto: false, autoPanel: null })
                    }}
                />
            ))}
            <button type="button" className="dim-btn icon add-camera" title="Add a camera panel" onClick={add}>
                <Icon name="camera" size={16} />
                <Icon name="plus" size={12} />
            </button>
        </div>
    )
}

function CameraPanel({ app, panel, index, topics, isMain, mobile, onChange, onClose, onMain }: {
    app: ViewerApp
    panel: PanelState
    index: number
    topics: Topic[]
    isMain: boolean
    mobile: boolean
    onChange: (patch: Partial<PanelState>) => void
    onClose: () => void
    onMain: () => void
}) {
    const element = useRef<HTMLDivElement>(null)
    const video = useRef<HTMLVideoElement>(null)
    const depthHost = useRef<HTMLDivElement>(null)
    const depthRenderer = useRef<DepthCanvas | null>(null)
    const depthLook = panel.depth ?? DEFAULT_DEPTH_LOOK
    const lookRef = useRef(depthLook)
    lookRef.current = depthLook
    const [depthRange, setDepthRange] = useState<[number, number] | null>(null)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
    // "(gone)" only once this topic was on the bus and then left, not while it's still being discovered
    const everSeen = useRef<string | null>(null)
    if (topic) {
        everSeen.current = panel.key
    } else if (everSeen.current !== panel.key) {
        everSeen.current = null
    }
    const [size, setSize] = useState({ width: 0, height: 0, fps: 0 })
    const depth = topic ? isDepthTopic(topic) : false

    // the stream (shared with a 3D projection of the same topic)
    useEffect(() => {
        if (!topic) {
            return
        }
        const source = app.video.acquire(topic)
        const unsubscribe = depth
            ? source.depth.subscribe(() => {
                const image = source.depth.get().image
                if (image && depthHost.current) {
                    if (!depthRenderer.current) {
                        depthRenderer.current = new DepthCanvas()
                        depthRenderer.current.canvas.className = "camera-media"
                        depthHost.current.prepend(depthRenderer.current.canvas)
                    }
                    const range = depthRenderer.current.draw(image, lookRef.current)
                    setDepthRange((old) => old && Math.abs(old[0] - range[0]) < 0.05 && Math.abs(old[1] - range[1]) < 0.05 ? old : range)
                    setSize((old) => old.width === image.width ? old : { width: image.width, height: image.height, fps: 0 })
                }
            })
            : source.video.subscribe(() => {
                const state = source.video.get()
                if (video.current && state.stream && video.current.srcObject !== state.stream) {
                    video.current.srcObject = state.stream
                    video.current.play().catch(() => {})
                }
                setSize({ width: state.width, height: state.height, fps: state.fps })
            })
        const state = source.video.get()
        if (!depth && video.current && state.stream) {
            video.current.srcObject = state.stream
            video.current.play().catch(() => {})
        }
        return () => {
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key])

    // the overlay (latest message, redrawn as it arrives)
    useEffect(() => {
        const overlayTopic = topics.find((other) => other.key === panel.overlay)
        const type = overlayTopic && overlayTypeFor(overlayTopic.type)
        const canvas = overlayCanvas.current
        if (!overlayTopic || !type || !canvas) {
            canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height)
            return
        }
        return app.connection.subscribe(overlayTopic.key, { delivery: "latest", maxHz: 30 }, (message) => {
            const context = canvas.getContext("2d")!
            const width = size.width || canvas.width, height = size.height || canvas.height
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width
                canvas.height = height
            }
            context.clearRect(0, 0, width, height)
            try {
                type.draw(context, decode(overlayTopic.type, message.bytes), { width, height })
            } catch {
                // a message the overlay can't read: leave it blank
            }
        })
    }, [app, panel.overlay, topics.length, size.width, size.height])

    // drag by the header (desktop, floating only)
    const startDrag = (event: React.PointerEvent) => {
        if (isMain || mobile || (event.target as HTMLElement).closest("button, select")) {
            return
        }
        const box = element.current!.getBoundingClientRect()
        const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top
        const move = (moved: PointerEvent) => {
            const x = Math.max(0, Math.min(innerWidth - 80, moved.clientX - offsetX))
            const y = Math.max(48, Math.min(innerHeight - 40, moved.clientY - offsetY))
            element.current!.style.left = `${x}px`
            element.current!.style.top = `${y}px`
            element.current!.style.right = "auto"
        }
        const up = () => {
            removeEventListener("pointermove", move)
            removeEventListener("pointerup", up)
            const after = element.current!.getBoundingClientRect()
            onChange({ x: after.left, y: after.top })
        }
        addEventListener("pointermove", move)
        addEventListener("pointerup", up)
    }

    // size: this viewer's width (dragged with the corner handle, kept in localStorage), the height from the image's
    // aspect, so there are never bars; until the image's size is known, the default 16:9
    const [viewerWidth, setViewerWidth] = useState<number | null>(() => loadPanelWidth(panel.id))
    const aspect = size.width && size.height ? size.height / size.width : 9 / 16
    const width = clampWidth(viewerWidth ?? (panel.fitted ? panel.width : defaultSize().width), aspect)
    const height = Math.round(width * aspect) + HEAD_PX
    // the handle sits on the corner facing into the screen: bottom-left for a panel on the right half (the default)
    const handleLeft = panel.x < 0 || panel.x + width / 2 > (globalThis.innerWidth || 1280) / 2
    const startResize = (event: React.PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        const box = element.current!.getBoundingClientRect()
        const startX = event.clientX, startWidth = box.width
        const handle = event.currentTarget as HTMLElement
        handle.setPointerCapture(event.pointerId)
        let latest = startWidth
        const move = (moved: PointerEvent) => {
            const grown = handleLeft ? startX - moved.clientX : moved.clientX - startX
            latest = clampWidth(startWidth + grown, aspect)
            // the far edge stays put: growing to the left moves the left edge
            element.current!.style.width = `${latest}px`
            element.current!.style.height = `${Math.round(latest * aspect) + HEAD_PX}px`
            if (handleLeft && panel.x >= 0) {
                element.current!.style.left = `${box.right - latest}px`
            }
        }
        const up = () => {
            handle.removeEventListener("pointermove", move)
            handle.removeEventListener("pointerup", up)
            handle.removeEventListener("pointercancel", up)
            setViewerWidth(latest)
            savePanelWidth(panel.id, latest)
            if (handleLeft && panel.x >= 0) {
                onChange({ x: box.right - latest })
            }
        }
        handle.addEventListener("pointermove", move)
        handle.addEventListener("pointerup", up)
        handle.addEventListener("pointercancel", up)
    }

    // the quality menu (gear over the picture)
    const [qualityOpen, setQualityOpen] = useState(false)
    const quality = useQuality(app, topic, depth)
    useEffect(() => {
        if (!qualityOpen) {
            return
        }
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".camera-quality, .quality-menu")) {
                setQualityOpen(false)
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [qualityOpen])

    const floating = !isMain
    const style: React.CSSProperties = floating && !mobile
        ? { width, height, ...(panel.x >= 0 ? { left: panel.x, top: panel.y } : { right: 12, top: 60 + index * (height + 12) }) }
        : mobile && floating && size.width && size.height
        ? { "--cam-aspect": (size.height / size.width).toFixed(4) } as React.CSSProperties
        : {}
    const info = size.width ? `${size.width}×${size.height}${size.fps ? ` · ${size.fps} fps` : ""}${depth && depthRange ? ` · ${depthRange[0].toFixed(1)}–${depthRange[1].toFixed(1)} m` : ""}` : ""
    const overlays = topics.filter((other) => overlayTypeFor(other.type))
    return (
        <div ref={element} className={`dim-panel camera-panel ${isMain ? "main" : "floating"}`} style={style} data-panel={panel.id}>
            <div className="camera-head" onPointerDown={startDrag} onDoubleClick={onMain} title={info}>
                <select className="dim-select" value={panel.key} onChange={(event) => onChange({ key: event.target.value })} aria-label="Camera topic">
                    {!topic && <option value={panel.key}>{!panel.key ? "pick a camera" : (everSeen.current ? "(gone) " : "") + (parseKey(panel.key)?.name ?? panel.key)}</option>}
                    {topics.filter(isImage).map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}
                </select>
                {overlays.length > 0 && (
                    <select className="dim-select" value={panel.overlay} onChange={(event) => onChange({ overlay: event.target.value })} aria-label="Overlay">
                        <option value="">no overlay</option>
                        {overlays.map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}
                    </select>
                )}
                {depth && (
                    <>
                        <select className="dim-select" value={depthLook.colormap} onChange={(event) => onChange({ depth: { ...depthLook, colormap: event.target.value } })} aria-label="Depth colormap">
                            {DEPTH_COLORMAPS.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <input className="dim-input number depth-range" type="number" step="0.1" placeholder="near" title="near (m); empty = auto" value={depthLook.near ?? ""} onChange={(event) => onChange({ depth: { ...depthLook, near: event.target.value === "" ? null : Number(event.target.value) } })} />
                        <input className="dim-input number depth-range" type="number" step="0.1" placeholder="far" title="far (m); empty = auto" value={depthLook.far ?? ""} onChange={(event) => onChange({ depth: { ...depthLook, far: event.target.value === "" ? null : Number(event.target.value) } })} />
                    </>
                )}
                <span className="camera-info">{info || "…"}</span>
                <button type="button" className="dim-btn icon icon-button" title={isMain ? "Back to the 3D view" : "Fullscreen camera (3D becomes a popup)"} onClick={onMain}><Icon name="expand" size={15} /></button>
                <button type="button" className="dim-btn icon icon-button" title="Close" onClick={onClose}><Icon name="close" size={15} /></button>
            </div>
            <div className="camera-body" onClick={mobile && !isMain ? onMain : undefined}>
                {depth ? <div ref={depthHost} className="camera-media depth-host" /> : <video ref={video} className="camera-media" muted playsInline autoPlay />}
                <canvas ref={overlayCanvas} className="camera-overlay" />
                {topic && !depth && (!mobile || isMain) && (
                    <div className={`camera-quality ${qualityOpen ? "open" : ""}`} onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="dim-btn icon quality-gear" title={`Video quality: ${presetFor(quality).label}`} aria-label="Video quality" aria-haspopup="menu" aria-expanded={qualityOpen} onClick={() => setQualityOpen(!qualityOpen)}>
                            <Icon name="settings" size={14} />
                        </button>
                        {qualityOpen && createPortal(
                            <div className="dim-panel quality-menu" role="menu" aria-label="Video quality" style={menuPosition(element.current)} onClick={(event) => event.stopPropagation()}>
                                <div className="quality-title">Video quality</div>
                                {QUALITY_PRESETS.map((preset) => (
                                    <button
                                        key={preset.id}
                                        type="button"
                                        role="menuitemradio"
                                        aria-checked={quality === preset.id}
                                        className={`quality-option ${quality === preset.id ? "on" : ""}`}
                                        onClick={() => {
                                            app.video.setQuality(topic, preset.id)
                                            setQualityOpen(false)
                                        }}
                                    >
                                        <span className="quality-name">{preset.label}</span>
                                        <span className="quality-about">{preset.about}</span>
                                    </button>
                                ))}
                            </div>,
                            document.body,
                        )}
                    </div>
                )}
            </div>
            {floating && !mobile && (
                <div className={`camera-resize ${handleLeft ? "left" : "right"}`} title="Drag to resize" aria-label="Resize the camera" onPointerDown={startResize} />
            )}
        </div>
    )
}

/** The smallest and largest a floating camera gets: at least 200 px wide, at most the window between the top bar and
 * the drive guide (so the handle in the corner stays reachable). */
function clampWidth(width: number, aspect: number) {
    const maxWidth = Math.min((globalThis.innerWidth || 1280) - 24, ((globalThis.innerHeight || 800) - 60 - 110 - HEAD_PX) / aspect)
    return Math.round(Math.max(Math.min(200, maxWidth), Math.min(maxWidth, width)))
}

/** panel id → width this viewer dragged it to (per viewer: a phone and a desktop don't share it) */
const SIZE_KEY = "lv.cameras.width"
const loadPanelWidth = (id: number): number | null => readLocal<Record<string, number>>(SIZE_KEY, {})[id] ?? null
const savePanelWidth = (id: number, width: number) => writeLocal(SIZE_KEY, { ...readLocal<Record<string, number>>(SIZE_KEY, {}), [id]: width })

/** The topic's quality preset as the shared source has it (changes in another panel of the same topic show here). */
function useQuality(app: ViewerApp, topic: Topic | null, depth: boolean): VideoQuality {
    const [quality, setQuality] = useState<VideoQuality>("auto")
    useEffect(() => {
        if (!topic || depth) {
            return
        }
        const source = app.video.acquire(topic)
        const apply = () => setQuality(source.quality.get().quality)
        apply()
        const unsubscribe = source.quality.subscribe(apply)
        return () => {
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key, depth])
    return quality
}

/** The quality menu hangs from the panel's top-right corner, kept inside the window (a portal: the panel clips). */
function menuPosition(panel: HTMLElement | null): React.CSSProperties {
    const box = panel?.getBoundingClientRect()
    if (!box) {
        return {}
    }
    const menuWidth = 236
    const left = Math.max(8, Math.min(box.right - menuWidth - 6, innerWidth - menuWidth - 8))
    const top = Math.min(box.top + 33 + 38, innerHeight - 220)
    return { position: "fixed", left, top, zIndex: 40 }
}
