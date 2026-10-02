// Camera panels: one by default (the profile's preferred camera), more on demand. Any panel can take over the
// screen, which shrinks the 3D view into a picture-in-picture. Depth is drawn as a colormap; 2D detections can be
// overlaid on any panel.
import { useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { type DepthImage, isDepthTopic } from "../core/video.ts"
import { overlayTypeFor } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { sampleGradient } from "../core/render/gradients.ts"
import { Icon } from "./icons.tsx"

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
}

export interface CameraLayout {
    panels: PanelState[]
    /** the panel shown fullscreen (the 3D view becomes a picture-in-picture), or null */
    main: number | null
}

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

export function CameraPanels({ app, layout, mobile }: { app: ViewerApp; layout: Store<CameraLayout>; mobile: boolean }) {
    const { panels, main } = useStore(layout)
    const { topics } = useStore(app.connection.status)

    // the first time a camera shows up, open exactly one panel on it
    useEffect(() => {
        if (panels.length || localStorage.getItem("lv.cameras.seeded")) {
            return
        }
        const first = pickDefault(app, topics)
        if (first) {
            localStorage.setItem("lv.cameras.seeded", "1")
            layout.update({ panels: [{ id: 1, key: first.key, overlay: "", x: -1, y: -1, width: 360, height: 240 }] })
        }
    }, [topics, panels.length, app, layout])

    const update = (id: number, patch: Partial<PanelState>) => layout.update({ panels: layout.get().panels.map((panel) => panel.id === id ? { ...panel, ...patch } : panel) })
    const close = (id: number) => layout.update({ panels: layout.get().panels.filter((panel) => panel.id !== id), main: layout.get().main === id ? null : layout.get().main })
    const add = () => {
        const used = new Set(panels.map((panel) => panel.key))
        const next = topics.filter(isImage).find((topic) => !used.has(topic.key)) ?? pickDefault(app, topics)
        const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
        layout.update({ panels: [...panels, { id, key: next?.key ?? "", overlay: "", x: -1, y: -1, width: 360, height: 240 }] })
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
                    onMain={() => layout.update({ main: main === panel.id ? null : panel.id })}
                />
            ))}
            <button type="button" className="add-camera" title="Add a camera panel" onClick={add}>
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
    const depthCanvas = useRef<HTMLCanvasElement>(null)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
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
                if (image && depthCanvas.current) {
                    drawDepth(depthCanvas.current, image)
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

    // remember a resize
    useEffect(() => {
        const box = element.current
        if (!box || isMain || mobile) {
            return
        }
        let timer: ReturnType<typeof setTimeout>
        const observer = new ResizeObserver(() => {
            clearTimeout(timer)
            timer = setTimeout(() => {
                if (Math.abs(box.offsetWidth - panel.width) > 2 || Math.abs(box.offsetHeight - panel.height) > 2) {
                    onChange({ width: box.offsetWidth, height: box.offsetHeight })
                }
            }, 300)
        })
        observer.observe(box)
        return () => observer.disconnect()
    }, [isMain, mobile, panel.width, panel.height])

    const floating = !isMain
    const style: React.CSSProperties = floating && !mobile
        ? { width: panel.width, height: panel.height, ...(panel.x >= 0 ? { left: panel.x, top: panel.y } : { right: 12, top: 60 + index * 24 }) }
        : {}
    const overlays = topics.filter((other) => overlayTypeFor(other.type))
    return (
        <div ref={element} className={`camera-panel ${isMain ? "main" : "floating"}`} style={style} data-panel={panel.id}>
            <div className="camera-head" onPointerDown={startDrag} onDoubleClick={onMain}>
                <select value={panel.key} onChange={(event) => onChange({ key: event.target.value })} aria-label="Camera topic">
                    {!topic && <option value={panel.key}>{panel.key ? "(gone) " + panel.key : "pick a camera"}</option>}
                    {topics.filter(isImage).map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}
                </select>
                {overlays.length > 0 && (
                    <select value={panel.overlay} onChange={(event) => onChange({ overlay: event.target.value })} aria-label="Overlay">
                        <option value="">no overlay</option>
                        {overlays.map((other) => <option key={other.key} value={other.key}>{other.name}</option>)}
                    </select>
                )}
                <span className="camera-info">{size.width ? `${size.width}×${size.height}${size.fps ? ` · ${size.fps} fps` : ""}` : "…"}</span>
                <button type="button" className="icon-button" title={isMain ? "Back to the 3D view" : "Fullscreen camera (3D becomes a popup)"} onClick={onMain}><Icon name="expand" size={15} /></button>
                <button type="button" className="icon-button" title="Close" onClick={onClose}><Icon name="close" size={15} /></button>
            </div>
            <div className="camera-body" onClick={mobile && !isMain ? onMain : undefined}>
                {depth ? <canvas ref={depthCanvas} className="camera-media" /> : <video ref={video} className="camera-media" muted playsInline autoPlay />}
                <canvas ref={overlayCanvas} className="camera-overlay" />
            </div>
        </div>
    )
}

/** Depth as a near-red/far-blue colormap over the 2nd–98th percentile (zero and NaN = no return, black). */
function drawDepth(canvas: HTMLCanvasElement, image: DepthImage) {
    const { width, height, data } = image
    if (!width || !height || data.length < width * height) {
        return
    }
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
    }
    const step = Math.max(1, Math.floor(data.length / 4096))
    const samples: number[] = []
    for (let index = 0; index < data.length; index += step) {
        const value = data[index]
        if (value > 0 && Number.isFinite(value)) {
            samples.push(value)
        }
    }
    samples.sort((a, b) => a - b)
    const near = samples[Math.floor(samples.length * 0.02)] ?? 0
    const far = samples[Math.floor(samples.length * 0.98)] ?? 1
    const context = canvas.getContext("2d")!
    const pixels = context.createImageData(width, height)
    const lut = new Uint8Array(256 * 3)
    for (let index = 0; index < 256; index++) {
        lut.set(sampleGradient("turbo", 1 - index / 255).map(Math.round), index * 3)
    }
    for (let index = 0; index < width * height; index++) {
        const value = data[index]
        const at = index * 4
        pixels.data[at + 3] = 255
        if (!(value > 0) || !Number.isFinite(value)) {
            continue
        }
        const t = Math.max(0, Math.min(255, Math.round(((value - near) / (far - near || 1)) * 255))) * 3
        pixels.data[at] = lut[t]
        pixels.data[at + 1] = lut[t + 1]
        pixels.data[at + 2] = lut[t + 2]
    }
    context.putImageData(pixels, 0, 0)
}
