// Camera panels (ui/workspace.ts ids camera:<n>): one from the start (the profile's preferred camera once one is on
// the bus; until then it says there's none), more from the palette. Each is a workspace panel like any other (the
// main view by default). Its tools: a tab per image topic (a phone's main view: the top bar's view switch instead), a 2D detection overlay, the depth colormap and range, a snapshot and the gallery; a gear
// over the picture picks latency vs quality. Depth is drawn as a colormap. Collapsed (or off screen: a shut drawer, a
// rail hidden by focus, a hidden browser tab) it holds no stream and no overlay subscription. As the main view it offers the dock fit / fill, the next camera and quality.
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { persistentStore, useStore } from "../core/store.ts"
import { parseKey, type Topic } from "../core/transport.ts"
import { type DepthImage, isDepthTopic, pageVisibility, panelStreams } from "../core/video.ts"
import { cameraTabs, isImage, pickDefault as pickPreferred, retargetPanels } from "../core/cameraChoice.ts"
import { overlayTypeFor } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { DEFAULT_DEPTH_LOOK, DEPTH_COLORMAPS, DepthCanvas, type DepthLook } from "../core/render/depth.ts"
import { canvasToPng, composeSnapshot, saveSnapshot } from "../core/snapshots.ts"
import { SnapshotTools } from "./SnapshotGallery.tsx"
import { UndistortCanvas, undistortInfoFor } from "../core/render/undistort.ts"
import { type CameraModel, cameraModel } from "dimos-react/three"
import { Button, Card, NumberInput, Select } from "dimos-react"
import { Icon } from "./icons.tsx"
import { popoverPosition } from "./panelDrag.ts"
import { Panel } from "./Panel.tsx"
import { useWorkspaceApi } from "./Workspace.tsx"
import { useDockActions } from "./dockActions.ts"
import { ContainCrash, Unavailable } from "./Unavailable.tsx"
import { createHoldZoom, HOLD_ZOOM } from "../core/holdZoom.ts"
import { createTripleTap, zoomDebug } from "../core/zoomDebug.ts"
import { presetFor, QUALITY_PRESETS, readLocal, type VideoQuality, writeLocal } from "../core/videoQuality.ts"
import { panelTitle } from "./commands.ts"
import { bandwidthOverrides, setOverride } from "../core/bandwidth.ts"
import { cameraId, isCamera, workspace } from "./workspace.ts"
import type { CameraActions } from "./useCommands.ts"

/** a camera view with no new picture for this long says "slow / stopped link" and drops its fps */
const STALL_MS = 1000
/** stalled this long while on screen, the camera subscribes afresh (a stream lost in a reconnect or a source swap never comes back on its own), then again less and less often while it stays stalled */
const RESUBSCRIBE_MS = 3000

export interface PanelState {
    id: number
    /** image topic key ("" until one is picked) */
    key: string
    /** the topic key the viewer picked from the list (core/cameraChoice.ts shows it again whenever it's on the bus) */
    picked?: string
    /** overlay topic key ("" = none) */
    overlay: string
    /** depth topics: colormap and fixed range (null = auto) */
    depth?: DepthLook
}

export interface CameraLayout {
    panels: PanelState[]
}

/** the camera panels (a backend setting, so the agent can see which camera is shown) */
export const cameraLayout = persistentStore<CameraLayout>("lv.cameras", { panels: [] })

/** a lidar / point cloud: what makes the 3D view worth the screen */
export const isCloudTopic = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2" || /lidar/i.test(topic.name)

/** The camera panels as saved, made safe: unique positive ids (none at all is fine: every camera closed). */
export function cameraPanels(layout: Partial<CameraLayout> | null | undefined): PanelState[] {
    const seen = new Set<number>()
    const panels = (Array.isArray(layout?.panels) ? layout.panels : []).filter((panel) => panel && Number.isInteger(panel.id) && panel.id > 0 && !seen.has(panel.id) && seen.add(panel.id))
        .map((panel) => ({ id: panel.id, key: typeof panel.key === "string" ? panel.key : "", picked: panel.picked, overlay: typeof panel.overlay === "string" ? panel.overlay : "", depth: panel.depth }))
    return panels
}

const updatePanel = (id: number, patch: Partial<PanelState>) => cameraLayout.update({ panels: cameraPanels(cameraLayout.get()).map((panel) => panel.id === id ? { ...panel, ...patch } : panel) })

/** A new camera panel on the first image topic no camera shows (else the profile's preferred one, else `key`); its workspace id. */
export function addCameraPanel(topics: Topic[], preferred: string[], key?: string): string {
    const panels = cameraPanels(cameraLayout.get())
    const used = new Set(panels.map((panel) => panel.key))
    const next = key ?? (topics.filter(isImage).find((topic) => !used.has(topic.key)) ?? pickPreferred(preferred, topics))?.key ?? ""
    const id = Math.max(0, ...panels.map((panel) => panel.id)) + 1
    cameraLayout.update({ panels: [...panels, { id, key: next, overlay: "" }] })
    return cameraId(id)
}

/** A camera panel gone (its × or the palette); the workspace forgets it with it. */
export function removeCameraPanel(panelId: string) {
    if (!isCamera(panelId)) {
        return
    }
    const id = Number(panelId.split(":")[1])
    cameraLayout.update({ panels: cameraPanels(cameraLayout.get()).filter((panel) => panel.id !== id) })
}

/** Adding a camera panel, pointing the main one at a topic (or a new panel's, with none), and removing one. */
export function useCameraActions(app: ViewerApp | null): CameraActions {
    return {
        addCamera: () => addCameraPanel(app?.connection.status.get().topics ?? [], app?.profile.cameras.preferred ?? []),
        showTopic: (key: string) => {
            const stage = workspace.get().arrangement.stage
            const panels = cameraPanels(cameraLayout.get())
            const id = stage && isCamera(stage) ? Number(stage.split(":")[1]) : panels[0]?.id
            if (id === undefined) {
                addCameraPanel([], [], key)
                return
            }
            updatePanel(id, { key, picked: key })
        },
        removeCamera: (panelId: string) => {
            if (!isCamera(panelId)) {
                return
            }
            const id = Number(panelId.split(":")[1])
            cameraLayout.update({ panels: cameraPanels(cameraLayout.get()).filter((panel) => panel.id !== id) })
        },
    }
}

export function CameraPanels({ app }: { app: ViewerApp }) {
    const layout = useStore(cameraLayout)
    const panels = cameraPanels(layout)
    const { topics } = useStore(app.connection.status)
    // the main view's camera keeps the default bandwidth priority; the others yield before it
    const stage = useWorkspaceApi().arrangement.stage
    const mainKey = panels.find((panel) => cameraId(panel.id) === stage)?.key ?? null
    useEffect(() => app.video.setMain(mainKey), [app, mainKey])

    // a camera panel with no topic yet takes the profile's preferred camera as soon as one is on the bus
    const imageKeys = topics.filter(isImage).map((topic) => topic.key).join("|")
    useEffect(() => {
        const current = cameraPanels(cameraLayout.get())
        const empty = current.find((panel) => !panel.key)
        const first = empty && pickPreferred(app.profile.cameras.preferred, app.connection.status.get().topics)
        if (empty && first) {
            updatePanel(empty.id, { key: first.key })
        }
    }, [imageKeys, app])

    // a panel whose topic isn't on the bus (saved from another blueprint, the robot vs its sim) moves to the default
    // camera once the topics settle; the viewer's own pick comes back when it does
    useEffect(() => {
        if (!imageKeys) {
            return
        }
        const timer = setTimeout(() => {
            const next = retargetPanels(cameraPanels(cameraLayout.get()), app.connection.status.get().topics, app.profile.cameras.preferred)
            if (next) {
                cameraLayout.update({ panels: next })
            }
        }, SETTLE_MS)
        return () => clearTimeout(timer)
    }, [imageKeys, app])

    return (
        <>
            {panels.map((panel) => <ContainCrash key={panel.id} what="Camera"><CameraPanel app={app} panel={panel} topics={topics} onChange={(patch) => updatePanel(panel.id, patch)} /></ContainCrash>)}
        </>
    )
}

/** how long the topic list has to stay the same before a panel on a missing topic moves to one that's there */
const SETTLE_MS = 3000

function CameraPanel({ app, panel, topics, onChange }: {
    app: ViewerApp
    panel: PanelState
    topics: Topic[]
    onChange: (patch: Partial<PanelState>) => void
}) {
    const tools = useRef<HTMLDivElement>(null)
    const video = useRef<HTMLVideoElement>(null)
    const depthHost = useRef<HTMLDivElement>(null)
    const depthRenderer = useRef<DepthCanvas | null>(null)
    const [depthError, setDepthError] = useState<string | null>(null)
    const depthLook = panel.depth ?? DEFAULT_DEPTH_LOOK
    const lookRef = useRef(depthLook)
    lookRef.current = depthLook
    const [depthRange, setDepthRange] = useState<[number, number] | null>(null)
    const overlayCanvas = useRef<HTMLCanvasElement>(null)
    // the newest depth image, so a snapshot can draw it afresh (a WebGL canvas reads blank once it's been shown)
    const lastDepth = useRef<DepthImage | null>(null)
    const topic = topics.find((other) => other.key === panel.key) ?? null
    // "(gone)" only once this topic was on the bus and then left, not while it's still being discovered
    const everSeen = useRef<string | null>(null)
    if (topic) {
        everSeen.current = panel.key
    } else if (everSeen.current !== panel.key) {
        everSeen.current = null
    }
    const [size, setSize] = useState({ width: 0, height: 0, fps: 0 })
    // when a picture last reached the screen: the bridge's fps can hold while the track itself has stalled
    const lastPaint = useRef(0)
    const [stalled, setStalled] = useState(false)
    // it has resubscribed since the last picture (the banner says it's reconnecting, not just slow)
    const [reconnecting, setReconnecting] = useState(false)
    const depth = topic ? isDepthTopic(topic) : false
    const zoom = useHoldZoom(() => depth ? depthHost.current : video.current, [depth])
    const api = useWorkspaceApi()
    const slot = api.layout.slots[cameraId(panel.id)]
    // a phone's main view picks its camera from the top bar's view switch (ui/PhoneCorners.tsx)
    const switched = api.mobile && slot?.zone === "stage"
    const { hidden: pageHidden } = useStore(pageVisibility)
    const overrides = useStore(bandwidthOverrides)
    // paused in Network → Bandwidth Consumers: no subscription, so say so instead of looking stalled
    const paused = !!topic && !!overrides[topic.key]?.paused
    const open = panelStreams(slot, pageHidden)
    const pausedRef = useRef(paused)
    pausedRef.current = paused

    // the stream (shared with a 3D projection of the same topic), only while the panel is open
    useEffect(() => {
        if (!topic || !open) {
            return
        }
        const source = app.video.acquire(topic)
        let noWebGL = false
        const unsubscribe = depth
            ? source.depth.subscribe(() => {
                const image = source.depth.get().image
                lastDepth.current = image
                if (image && depthHost.current && !noWebGL) {
                    if (!depthRenderer.current) {
                        try {
                            depthRenderer.current = new DepthCanvas()
                        } catch (error) {
                            console.warn("depth view: WebGL2 unavailable", error)
                            noWebGL = true
                            setDepthError("this browser couldn't start WebGL2")
                            return
                        }
                        depthRenderer.current.canvas.className = "camera-media"
                        depthHost.current.prepend(depthRenderer.current.canvas)
                    }
                    const range = depthRenderer.current.draw(image, lookRef.current)
                    undistortDraw.current?.(depthRenderer.current.canvas)
                    lastPaint.current = performance.now()
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
        // source-to-screen latency of the frames this panel shows (the chip and Network; zenoh-gateway >= 0.5.21)
        const unwatch = !depth && video.current ? app.video.watchLatency(topic, video.current) : () => {}
        return () => {
            unwatch()
            unsubscribe()
            app.video.release(topic)
        }
    }, [app, topic?.key, open])

    // no new picture for STALL_MS: drop the fps and say so over the view
    useEffect(() => {
        const element = video.current
        if (!topic || !open) {
            setStalled(false)
            setReconnecting(false)
            return
        }
        lastPaint.current = performance.now()
        let frameCallback = 0
        const painted = () => {
            lastPaint.current = performance.now()
            frameCallback = element!.requestVideoFrameCallback(painted)
        }
        if (!depth && element) {
            frameCallback = element.requestVideoFrameCallback(painted)
        }
        // (a camera that stays dark is retried less and less often: 3 s, 6 s, ... 30 s, back to 3 s once a picture shows)
        let retriedAt = performance.now()
        let retryEvery = RESUBSCRIBE_MS
        // back from a hidden tab (it paints nothing while hidden): the stall clock starts again
        const onVisibility = () => {
            if (!document.hidden) {
                lastPaint.current = retriedAt = performance.now()
            }
        }
        document.addEventListener("visibilitychange", onVisibility)
        // a window behind others, or a hidden one the browser hasn't called hidden, paints nothing either: frames still
        // decoding count as a picture, and while the page itself isn't drawing (no animation frames) the clock waits
        let decodedFrames = 0
        let drewAt = performance.now()
        let animation = requestAnimationFrame(function drew() {
            drewAt = performance.now()
            animation = requestAnimationFrame(drew)
        })
        const timer = setInterval(() => {
            const now = performance.now()
            const decoded = !depth && element ? element.getVideoPlaybackQuality?.().totalVideoFrames ?? 0 : 0
            if (decoded > decodedFrames) {
                decodedFrames = decoded
                lastPaint.current = Math.max(lastPaint.current, now)
            }
            if (now - drewAt > STALL_MS) {
                lastPaint.current = retriedAt = now
            }
            setStalled(now - lastPaint.current > STALL_MS)
            if (lastPaint.current > retriedAt) {
                retryEvery = RESUBSCRIBE_MS
                setReconnecting(false)
            }
            if (now - lastPaint.current > RESUBSCRIBE_MS && now - retriedAt > retryEvery && !document.hidden && !pausedRef.current) {
                retriedAt = now
                retryEvery = Math.min(retryEvery * 2, 10 * RESUBSCRIBE_MS)
                setReconnecting(true)
                console.warn(`[cameras] ${topic.name}: no picture for ${((now - lastPaint.current) / 1000).toFixed(1)} s; resubscribing`)
                app.video.resubscribe(topic)
            }
        }, 250)
        return () => {
            clearInterval(timer)
            cancelAnimationFrame(animation)
            document.removeEventListener("visibilitychange", onVisibility)
            if (!depth && element) {
                element.cancelVideoFrameCallback(frameCallback)
            }
        }
    }, [app, topic?.key, open, depth])

    // the overlay (latest message, redrawn as it arrives)
    useEffect(() => {
        const overlayTopic = topics.find((other) => other.key === panel.overlay)
        const type = overlayTopic && overlayTypeFor(overlayTopic.type)
        const canvas = overlayCanvas.current
        if (!open || !overlayTopic || !type || !canvas) {
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
    }, [app, panel.overlay, topics.length, size.width, size.height, open])

    // the shown camera's tab in view (it can be off the end of a long row)
    useEffect(() => {
        const tab = tools.current?.querySelector<HTMLElement>(".camera-tab.on")
        const row = tab?.parentElement
        if (tab && row && (tab.offsetLeft < row.scrollLeft || tab.offsetLeft + tab.offsetWidth > row.scrollLeft + row.clientWidth)) {
            row.scrollLeft = tab.offsetLeft - 6
        }
    }, [panel.key, topics.length])

    // the whole picture letterboxed ("fit", object-fit: contain) or its box filled, edges cropped ("fill", cover); this viewer's, per panel
    const [fill, setFill] = useState(() => loadPanelFill(panel.id))
    const toggleFill = () => {
        setFill(!fill)
        savePanelFill(panel.id, !fill)
    }

    // the picture through its CameraInfo's lens model, straightened (Undistort); this viewer's, per panel. The CameraInfo is the
    // one picked in the gear menu (lv.cameras.info, image name → info name), else <image>_info, else the nearest camera_info
    const [undistort, setUndistort] = useState(() => loadPanelUndistort(panel.id))
    const toggleUndistort = () => {
        setUndistort(!undistort)
        savePanelUndistort(panel.id, !undistort)
    }
    const pickedInfos = useStore(cameraInfoPicks)
    const allTopics = useStore(app.connection.status).topics
    const infoTopic = topic ? undistortInfoFor(topic, allTopics, pickedInfos[topic.name], app.profile.cameras.cameraInfo) : null
    const [lens, setLens] = useState<{ key: string; model: CameraModel | null } | null>(null)
    useEffect(() => {
        setLens(null)
        if (!undistort || !open || !infoTopic) {
            return
        }
        // a camera's lens doesn't change: the first usable message is kept
        let stop: (() => void) | null = app.connection.subscribe(infoTopic.key, { delivery: "latest", maxHz: 2 }, (message) => {
            try {
                const model = cameraModel(decode("sensor_msgs.CameraInfo", message.bytes) as Parameters<typeof cameraModel>[0])
                setLens({ key: infoTopic.key, model })
                if (model) {
                    stop?.()
                    stop = null
                }
            } catch {
                setLens({ key: infoTopic.key, model: null })
            }
        })
        return () => stop?.()
    }, [app, undistort, open, infoTopic?.key])
    const model = lens?.key === infoTopic?.key ? lens?.model ?? null : null
    const undistorting = undistort && !!model
    const undistortCanvas = useRef<HTMLCanvasElement>(null)
    const undistortDraw = useRef<((source: HTMLVideoElement | HTMLCanvasElement) => void) | null>(null)
    useEffect(() => {
        const canvas = undistortCanvas.current
        if (!undistorting || !open || !canvas) {
            return
        }
        let renderer: UndistortCanvas
        try {
            renderer = new UndistortCanvas(canvas)
        } catch (error) {
            console.warn("undistort: WebGL2 unavailable", error)
            return
        }
        undistortDraw.current = (source) => renderer.draw(source, model!)
        const element = video.current
        let frameCallback = 0
        if (!depth && element) {
            const drew = () => {
                renderer.draw(element, model!)
                frameCallback = element.requestVideoFrameCallback(drew)
            }
            frameCallback = element.requestVideoFrameCallback(drew)
            renderer.draw(element, model!)
        } else if (depthRenderer.current) {
            renderer.draw(depthRenderer.current.canvas, model!)
        }
        return () => {
            undistortDraw.current = null
            element?.cancelVideoFrameCallback(frameCallback)
            renderer.dispose()
        }
    }, [undistorting, open, depth, model, topic?.key])
    const undistortTitle = !undistort
        ? `Undistort: straighten the picture through its lens model (${infoTopic ? `CameraInfo ${infoTopic.name}` : "needs a CameraInfo"}; pick another in the gear menu)`
        : model
        ? `Undistorted with ${infoTopic!.name} (click to show the raw picture)`
        : infoTopic
        ? `Undistort: waiting for ${infoTopic.name}`
        : `Undistort: no CameraInfo for ${topic?.name ?? "this camera"} (pick one in the gear menu)`
    const infoOptions = allTopics.filter((other) => other.type === "sensor_msgs.CameraInfo")

    // the latency/quality menu (gear over the picture)
    const [qualityOpen, setQualityOpen] = useState(false)
    const gear = useRef<HTMLButtonElement>(null)
    const quality = useQuality(app, open ? topic : null, depth)
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

    const info = size.width ? `${size.width}×${size.height}${size.fps && !stalled ? ` · ${size.fps} fps` : ""}${depth && depthRange ? ` · ${depthRange[0].toFixed(1)}–${depthRange[1].toFixed(1)} m` : ""}${undistort && !model ? (infoTopic ? " · waiting for CameraInfo" : " · no CameraInfo") : ""}` : ""
    const overlays = topics.filter((other) => overlayTypeFor(other.type))
    const tabs = cameraTabs(topics)
    const nextTab = tabs.length > 1 ? tabs[(tabs.findIndex((tab) => tab.topic.key === panel.key) + 1) % tabs.length] : null
    const qualityIndex = QUALITY_PRESETS.findIndex((preset) => preset.id === quality)
    const nextQuality = QUALITY_PRESETS[(qualityIndex + 1) % QUALITY_PRESETS.length]
    /** The picture as it shows now (undistorted if it is, the overlay on top), drawn afresh in this task: its WebGL canvases keep no picture once shown. */
    const takeSnapshot = async () => {
        const element = video.current
        let picture: HTMLVideoElement | HTMLCanvasElement | null = null
        if (depth && depthRenderer.current && lastDepth.current) {
            depthRenderer.current.draw(lastDepth.current, lookRef.current)
            picture = depthRenderer.current.canvas
        } else if (!depth && element?.videoWidth) {
            picture = element
        }
        if (!picture || !topic) {
            throw new Error("no picture yet")
        }
        if (undistorting && undistortDraw.current && undistortCanvas.current) {
            undistortDraw.current(picture)
            picture = undistortCanvas.current
        }
        const width = picture instanceof HTMLVideoElement ? picture.videoWidth : picture.width
        const height = picture instanceof HTMLVideoElement ? picture.videoHeight : picture.height
        const layers = overlayCanvas.current?.width ? [picture, overlayCanvas.current] : [picture]
        return saveSnapshot(await canvasToPng(composeSnapshot(layers, width, height)), "camera", topic.key)
    }
    useDockActions(cameraId(panel.id), [
        { id: "fill", label: fill ? "Fill" : "Fit", icon: fill ? "fill" : "fit", title: fill ? "Fill: the picture fills the view, edges cropped (click to fit the whole picture)" : "Fit: the whole picture, letterboxed (click to fill the view)", pressed: fill, run: toggleFill },
        { id: "undistort", label: "Undistort", icon: "undistort", title: undistortTitle, pressed: undistort, run: toggleUndistort },
        ...(nextTab ? [{ id: "next", label: "Next camera", icon: "camera", title: `Show ${nextTab.topic.name}`, run: () => onChange({ key: nextTab.topic.key, picked: nextTab.topic.key }) }] : []),
    ])
    return (
        <Panel
            id={cameraId(panel.id)}
            title={panelTitle(cameraId(panel.id))}
            icon="camera"
            className="camera-video"
            testid="camera-panel"
            onClose={() => removeCameraPanel(cameraId(panel.id))}
            info={info || (topic ? "…" : "")}
            bodyClassName={fill ? "camera-body fill" : "camera-body"}
            tools={
                <div className="camera-tools" ref={tools}>
                    {!switched && <div className="camera-tabs" role="tablist" aria-label="Cameras" onWheel={(event) => (event.currentTarget.scrollLeft += event.deltaY)}>
                        {!topic && panel.key && (
                            <span className="camera-tab gone" title={parseKey(panel.key)?.name ?? panel.key}>{(everSeen.current ? "(gone) " : "") + (parseKey(panel.key)?.name ?? panel.key)}</span>
                        )}
                        {tabs.map((tab) => (
                            <button
                                key={tab.topic.key}
                                type="button"
                                role="tab"
                                aria-selected={tab.topic.key === panel.key}
                                className={`camera-tab ${tab.topic.key === panel.key ? "on" : ""} ${tab.depth ? "depth" : ""}`}
                                title={`${tab.topic.name} (${tab.topic.type})`}
                                onClick={() => onChange({ key: tab.topic.key, picked: tab.topic.key })}
                            >
                                {tab.label}
                            </button>
                        ))}
                        {!tabs.length && !panel.key && <span className="camera-tab gone">no camera on the bus yet</span>}
                    </div>}
                    {overlays.length > 0 && (
                        <Select value={panel.overlay} options={[["", "no overlay"], ...overlays.map((other) => [other.key, other.name] as [string, string])]} onChange={(overlay) => onChange({ overlay })} aria-label="Overlay" />
                    )}
                    {depth && (
                        <>
                            <Select value={depthLook.colormap} options={DEPTH_COLORMAPS} onChange={(colormap) => onChange({ depth: { ...depthLook, colormap } })} aria-label="Depth colormap" />
                            <NumberInput nullable className="number depth-range" step={0.1} placeholder="near" title="near (m); empty = auto" value={depthLook.near} onChange={(near) => onChange({ depth: { ...depthLook, near } })} />
                            <NumberInput nullable className="number depth-range" step={0.1} placeholder="far" title="far (m); empty = auto" value={depthLook.far} onChange={(far) => onChange({ depth: { ...depthLook, far } })} />
                        </>
                    )}
                    {topic && <SnapshotTools what={`${topic.name} camera`} take={takeSnapshot} />}
                    <Button className="dr-btn--icon icon-button camera-fit labeled" pressed={fill} title={fill ? "Fill: the picture fills its space, edges cropped (click to fit the whole picture)" : "Fit: the whole picture, letterboxed (click to fill its space)"} onClick={toggleFill}>
                        <Icon name={fill ? "fill" : "fit"} size={15} />
                        <span className="icon-label">{fill ? "Fill" : "Fit"}</span>
                    </Button>
                    <Button className="dr-btn--icon icon-button camera-undistort labeled" pressed={undistort} title={undistortTitle} onClick={toggleUndistort}>
                        <Icon name="undistort" size={15} />
                        <span className="icon-label">Undistort</span>
                    </Button>
                    {topic && (
                        <div className={`camera-quality panel-chrome ${qualityOpen ? "open" : ""}`} onClick={(event) => event.stopPropagation()}>
                            <Button ref={gear} className="dr-btn--icon quality-gear" title={`Latency ↔ quality: ${presetFor(quality).label}`} aria-label="Latency or quality" aria-haspopup="menu" aria-expanded={qualityOpen} onClick={() => setQualityOpen(!qualityOpen)}>
                                <Icon name="settings" size={14} />
                            </Button>
                            {qualityOpen && createPortal(
                                <Card padded={false} className="quality-menu" role="menu" aria-label="Latency or quality" style={popoverPosition(gear.current, 236)} onClick={(event) => event.stopPropagation()}>
                                    <div className="quality-title">Undistort with</div>
                                    <div className="quality-info-pick">
                                        <Select
                                            aria-label="CameraInfo for undistort"
                                            value={pickedInfos[topic.name] ?? ""}
                                            options={[["", `auto${infoTopic && !pickedInfos[topic.name] ? ` (${infoTopic.name})` : ""}`], ...infoOptions.map((other) => [other.name, other.name] as [string, string])]}
                                            onChange={(name: string) => {
                                                const { [topic.name]: _, ...rest } = cameraInfoPicks.get()
                                                cameraInfoPicks.set(name ? { ...rest, [topic.name]: name } : rest)
                                            }}
                                        />
                                    </div>
                                    {!depth && <div className="quality-title">Latency ↔ quality</div>}
                                    {!depth && QUALITY_PRESETS.map((preset) => (
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
                                </Card>,
                                document.body,
                            )}
                        </div>
                    )}
                </div>
            }
        >
            {depth && depthError && <Unavailable what="Depth view" reason={depthError} />}
            {depth ? <div ref={depthHost} className={`camera-media depth-host ${undistorting ? "undistorted" : ""}`} style={zoom.style} {...zoom.handlers} /> : <video ref={video} className={`camera-media ${undistorting ? "undistorted" : ""}`} style={zoom.style} {...zoom.handlers} muted playsInline autoPlay disablePictureInPicture disableRemotePlayback />}
            {undistorting && <canvas ref={undistortCanvas} className="camera-media camera-undistorted" style={zoom.style} />}
            <canvas ref={overlayCanvas} className="camera-overlay" style={zoom.style} />
            {topic && paused && (
                <div className="camera-takeover" data-testid="camera-paused">
                    <span>Paused in Network</span>
                    <Button variant="primary" onClick={() => setOverride(topic.key, { paused: undefined })}>Resume</Button>
                </div>
            )}
            {topic && open && stalled && !paused && <div className="camera-stalled" data-testid="camera-stalled">{reconnecting ? "reconnecting…" : "slow / stopped link"}</div>}
            {!topic && <div className="camera-placeholder"><Icon name="camera" size={28} /><span>{!tabs.length ? "No camera on the bus yet" : switched ? "Pick a camera from the view switch (top bar)" : "Pick a camera from this panel's topic tabs (shown on hover) or the palette (/)"}</span></div>}
        </Panel>
    )
}

/** panel id → the picture fills its box (cropped) instead of fitting it; per viewer */
const FILL_KEY = "lv.cameras.fill"
const loadPanelFill = (id: number): boolean => readLocal<Record<string, boolean>>(FILL_KEY, {})[id] === true
const savePanelFill = (id: number, fill: boolean) => writeLocal(FILL_KEY, { ...readLocal<Record<string, boolean>>(FILL_KEY, {}), [id]: fill })

/** panel id → the picture undistorted through its CameraInfo; per viewer */
const UNDISTORT_KEY = "lv.cameras.undistort"
const loadPanelUndistort = (id: number): boolean => readLocal<Record<string, boolean>>(UNDISTORT_KEY, {})[id] === true
const savePanelUndistort = (id: number, on: boolean) => writeLocal(UNDISTORT_KEY, { ...readLocal<Record<string, boolean>>(UNDISTORT_KEY, {}), [id]: on })
/** image topic name → the CameraInfo topic name picked for undistorting it (shared settings) */
const cameraInfoPicks = persistentStore<Record<string, string>>("lv.cameras.info", {})

/** Press and hold on a camera to zoom in on that spot; moving while held looks around, letting go zooms back out. */
function useHoldZoom(surface: () => HTMLElement | null, deps: unknown[]) {
    const [origin, setOrigin] = useState<string | null>(null)
    const hold = useRef<ReturnType<typeof createHoldZoom> | null>(null)
    hold.current ??= createHoldZoom({
        onOrigin: (next, cause) => {
            setOrigin(next)
            // deferred like ui/ZoomDebug.tsx's event lines, so the log keeps their order
            setTimeout(() => zoomDebug.log(`ZOOM ${next ? `in at ${next}` : "OUT"} (${cause})`))
        },
    })
    const tripleTap = useRef(createTripleTap())
    useEffect(() => {
        zoomDebug.log("camera panel mounted")
        return () => {
            hold.current?.release("unmount")
            zoomDebug.log("camera panel unmounted")
        }
    }, [])
    // a still finger's long press (drag of the video, selection, the browser's menu) is never started; touch moves and
    // ends are followed on the page, for a hold whose pointer the browser cancelled anyway
    useEffect(() => {
        const element = surface()
        if (!element) {
            return
        }
        const refuse = (event: TouchEvent) => event.cancelable && event.preventDefault()
        const boxOf = () => element.getBoundingClientRect()
        const move = (event: TouchEvent) => event.touches[0] && hold.current!.touchMove(event.touches[0], boxOf())
        const end = (event: TouchEvent) => event.touches.length === 0 && hold.current!.touchEnd(event.type)
        const noDrag = (event: Event) => event.preventDefault()
        element.addEventListener("touchstart", refuse, { passive: false })
        element.addEventListener("dragstart", noDrag)
        addEventListener("touchmove", move, { passive: true })
        addEventListener("touchend", end, true)
        addEventListener("touchcancel", end, true)
        return () => {
            element.removeEventListener("touchstart", refuse)
            element.removeEventListener("dragstart", noDrag)
            removeEventListener("touchmove", move)
            removeEventListener("touchend", end, true)
            removeEventListener("touchcancel", end, true)
        }
    }, deps)
    const box = (event: ReactPointerEvent<HTMLElement>) => event.currentTarget.getBoundingClientRect()
    return {
        style: origin ? { transform: `scale(${HOLD_ZOOM})`, transformOrigin: origin } : undefined,
        handlers: {
            draggable: false,
            onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
                if (event.pointerType !== "mouse" && tripleTap.current(event.timeStamp)) {
                    zoomDebug.toggle()
                }
                if (event.button === 0) {
                    event.currentTarget.setPointerCapture(event.pointerId)
                }
                hold.current!.down(event, box(event))
            },
            onPointerMove: (event: ReactPointerEvent<HTMLElement>) => hold.current!.move(event, box(event)),
            onPointerUp: () => hold.current!.release("pointerup"),
            onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => hold.current!.cancel(event.pointerType),
            onContextMenu: (event: ReactMouseEvent<HTMLElement>) => hold.current!.contextMenu(event),
        },
    }
}

/** The topic's quality preset as the shared source has it (changes in another panel of the same topic show here). */
function useQuality(app: ViewerApp, topic: Topic | null, depth: boolean): VideoQuality {
    const [quality, setQuality] = useState<VideoQuality>("balanced")
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
