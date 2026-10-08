// The 2D map: a floating, collapsible, top-down panel (north-up: +x right, +y up) with the occupancy grid on the bus
// (or, without one, a point cloud seen from above), the robot's pose, heading and trail, the world axes and a scale
// bar. View-only: wheel / pinch zoom and drag pan move the picture, never the robot. Redrawn only when something
// changed (new data, the robot moved, a zoom or pan, a resize, the theme).
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { decode, headerFrameId, type LcmValue } from "../core/lcm/lcm.ts"
import { poseMatrix } from "../core/layers/helpers.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import {
    chooseMapTopic,
    fitView,
    floorPose,
    formatMeters,
    gridLut,
    gridPixels,
    isGridTopic,
    mapCandidates,
    type MapView,
    niceLength,
    pan,
    projectCloud,
    type ProjectedCloud,
    type Rgba,
    Trail,
    worldToScreen,
    zoomAt,
} from "../core/map2d.ts"
import { Icon } from "./icons.tsx"
import { startPanelDrag } from "./panelDrag.ts"

/** what this viewer remembers about the panel (localStorage: a phone and a desktop each keep their own) */
interface MapLayout {
    collapsed: boolean
    /** fills the area under the top bar */
    full: boolean
    /** -1: the default corner */
    x: number
    y: number
    width: number
    height: number
    /** "" = the best map on the bus */
    topic: string
    follow: boolean
    view: MapView | null
}

const LAYOUT_KEY = "lv.map2d"
const HEAD_PX = 33
const MIN_WIDTH = 200, MIN_HEIGHT = 150

function loadLayout(mobile: boolean): MapLayout {
    const defaults: MapLayout = { collapsed: mobile, full: false, x: -1, y: -1, width: 320, height: 320 + HEAD_PX, topic: "", follow: true, view: null }
    return { ...defaults, ...readLocal<Partial<MapLayout>>(LAYOUT_KEY, {}) }
}

export function MapPanel({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const [layout, setLayout] = useState(() => loadLayout(mobile))
    const update = (patch: Partial<MapLayout>) =>
        setLayout((old) => {
            const next = { ...old, ...patch }
            writeLocal(LAYOUT_KEY, next)
            return next
        })
    const { topics } = useStore(app.connection.status)
    const topic = chooseMapTopic(topics, layout.topic)
    const candidates = mapCandidates(topics)
    const element = useRef<HTMLDivElement>(null)
    const canvas = useRef<HTMLCanvasElement>(null)
    const renderer = useRef<MapRenderer | null>(null)
    const [status, setStatus] = useState({ info: "", problem: "" })

    // the renderer lives while the panel is open; collapsed, nothing is subscribed or drawn
    const open = !layout.collapsed
    useEffect(() => {
        if (!open || !canvas.current) {
            return
        }
        const created = new MapRenderer(app, canvas.current, layout.view, layout.follow, {
            onView: (view) => update({ view }),
            onFollow: (follow) => update({ follow }),
            onStatus: (next) => setStatus((old) => old.info === next.info && old.problem === next.problem ? old : next),
        })
        renderer.current = created
        return () => {
            created.dispose()
            renderer.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app, open])

    useEffect(() => {
        renderer.current?.setFollow(layout.follow)
    }, [layout.follow, open])

    useEffect(() => {
        renderer.current?.setTopic(topic)
    }, [topic?.key, open])

    const startDrag = (event: ReactPointerEvent) => {
        if (layout.full || mobile || (event.target as HTMLElement).closest("button, select")) {
            return
        }
        startPanelDrag(event, element.current!, (x, y) => update({ x, y }))
    }

    const startResize = (event: ReactPointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        const panel = element.current!
        const box = panel.getBoundingClientRect()
        const startX = event.clientX, startY = event.clientY
        const handle = event.currentTarget as HTMLElement
        handle.setPointerCapture(event.pointerId)
        let width = box.width, height = box.height
        const move = (moved: PointerEvent) => {
            width = Math.round(Math.max(MIN_WIDTH, Math.min(innerWidth - box.left - 8, box.width + moved.clientX - startX)))
            height = Math.round(Math.max(MIN_HEIGHT, Math.min(innerHeight - box.top - 8, box.height + moved.clientY - startY)))
            panel.style.width = `${width}px`
            panel.style.height = `${height}px`
        }
        const up = () => {
            handle.removeEventListener("pointermove", move)
            handle.removeEventListener("pointerup", up)
            handle.removeEventListener("pointercancel", up)
            update({ width, height, x: box.left, y: box.top })
        }
        handle.addEventListener("pointermove", move)
        handle.addEventListener("pointerup", up)
        handle.addEventListener("pointercancel", up)
    }

    const placed = layout.x >= 0 ? { left: Math.min(layout.x, Math.max(0, (globalThis.innerWidth || 1280) - 80)), top: Math.min(layout.y, Math.max(48, (globalThis.innerHeight || 800) - 40)) } : {}
    const style: React.CSSProperties = mobile || layout.full ? {} : open ? { ...placed, width: layout.width, height: layout.height } : placed
    const label = topic ? `${topic.name}${isGridTopic(topic) ? "" : " (top-down)"}` : "no map on the bus"
    return (
        <div className="map-layer">
            <div ref={element} className={`dim-panel camera-panel map-panel ${open ? "open" : "collapsed"} ${layout.full && open ? "main" : ""}`} style={style}>
                <div className="camera-head" onPointerDown={startDrag} onDoubleClick={() => open && !mobile && update({ full: !layout.full })} title={status.info}>
                    <span className="map-title"><Icon name="map" size={14} />Map</span>
                    {open && candidates.length > 1 && (
                        <select className="dim-select" value={layout.topic} onChange={(event) => update({ topic: event.target.value })} aria-label="Map topic">
                            <option value="">auto ({label})</option>
                            {candidates.map((other) => <option key={other.key} value={other.key}>{other.name}{isGridTopic(other) ? "" : " (top-down)"}</option>)}
                        </select>
                    )}
                    {open && candidates.length <= 1 && <span className="camera-info map-source">{label}</span>}
                    {open && <span className="camera-info">{status.info}</span>}
                    {open && (
                        <>
                            <button type="button" className="dim-btn icon icon-button map-follow" aria-pressed={layout.follow} title={layout.follow ? "Following the robot (drag the map to stop)" : "Follow the robot"} onClick={() => update({ follow: !layout.follow })}>
                                <Icon name="target" size={15} />
                            </button>
                            <button type="button" className="dim-btn icon icon-button" title="Fit the whole map" onClick={() => renderer.current?.fit()}>
                                <Icon name="fit" size={15} />
                            </button>
                            {!mobile && (
                                <button type="button" className="dim-btn icon icon-button" title={layout.full ? "Back to a floating panel" : "Fullscreen map"} onClick={() => update({ full: !layout.full })}>
                                    <Icon name={layout.full ? "fullscreen-exit" : "fullscreen"} size={15} />
                                </button>
                            )}
                        </>
                    )}
                    <button type="button" className="dim-btn icon icon-button" aria-expanded={open} title={open ? "Collapse the map" : "Show the 2D map"} onClick={() => update({ collapsed: open, full: open ? false : layout.full })}>
                        <Icon name={open ? "chevron-up" : "chevron-down"} size={15} />
                    </button>
                </div>
                {open && (
                    <div className="camera-body map-body">
                        <canvas ref={canvas} className="map-canvas" aria-label="Top-down map" />
                        {status.problem && <div className="map-problem">{status.problem}</div>}
                    </div>
                )}
                {open && !layout.full && !mobile && <div className="camera-resize right" title="Drag to resize" aria-label="Resize the map" onPointerDown={startResize} />}
            </div>
        </div>
    )
}

interface Palette {
    background: Rgba
    fg: Rgba
    muted: Rgba
    primary: Rgba
    robot: Rgba
    gridLut: Uint8ClampedArray
    cloudLow: Rgba
    cloudHigh: Rgba
}

const css = ([r, g, b, a]: Rgba, alpha = 1) => `rgba(${r}, ${g}, ${b}, ${(a / 255) * alpha})`
const blend = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2, 3].map((index) => Math.round(a[index] + (b[index] - a[index]) * t)) as Rgba

/** A theme token (any CSS color, color-mix included) as rgba bytes, read back off a 1×1 canvas. */
function token(name: string, fallback: string): Rgba {
    const probe = document.createElement("span")
    probe.style.color = `var(${name})`
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    const pixel = document.createElement("canvas")
    pixel.width = pixel.height = 1
    const context = pixel.getContext("2d", { willReadFrequently: true })!
    context.fillStyle = fallback
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a]
}

function themePalette(): Palette {
    const background = token("--scene-bg, var(--bg)", "#05070d")
    const fg = token("--fg", "#ece8f0"), muted = token("--muted-fg", "#8e8898"), primary = token("--primary", "#7cc8ec")
    const opaque = (color: Rgba): Rgba => [color[0], color[1], color[2], 255]
    const base = opaque(background)
    return {
        background: base,
        fg,
        muted,
        primary,
        robot: token("--warn", "#e8bf6a"),
        // free floor a shade off the background, costs toward the accent, walls in the text color, unknown clear
        gridLut: gridLut({ free: blend(base, opaque(fg), 0.1), low: blend(base, opaque(primary), 0.3), high: blend(base, opaque(primary), 0.8), lethal: opaque(fg), unknown: [0, 0, 0, 0] }),
        cloudLow: blend(base, opaque(muted), 0.45),
        cloudHigh: opaque(primary),
    }
}

interface GridData {
    width: number
    height: number
    resolution: number
    // deno-lint-ignore no-explicit-any
    origin: any
    data: Int8Array
    frame: string
}

/** How far the robot moves (m) or turns (rad) before the map is redrawn for it. */
const POSE_EPSILON = 0.005
const YAW_EPSILON = 0.005
/** the default zoom before there's anything to fit */
const DEFAULT_METERS_PER_PIXEL = 0.05

/** Draws the map onto its canvas (no React): subscriptions, view, interaction. */
class MapRenderer {
    #view: MapView
    #fitted: boolean
    #follow: boolean
    #palette = themePalette()
    #topic: Topic | null = null
    #stop: (() => void)[] = []
    #grid: GridData | null = null
    #gridImage: HTMLCanvasElement | null = null
    #gridPixels: Uint8ClampedArray | undefined
    #cloud: ProjectedCloud | null = null
    #cloudImage: HTMLCanvasElement | null = null
    #cloudFrame: string | null = null
    /** the grid's (0,0) corner in the fixed frame, as last drawn */
    #gridPose: { x: number; y: number; yaw: number } | null = null
    #robot: { x: number; y: number; yaw: number } | null = null
    #trail = new Trail()
    #fixedFrame = ""
    #frameRequest = 0
    #pointers = new Map<number, { x: number; y: number }>()
    #dragged = false
    #problem = ""
    #info = ""
    #dispose: (() => void)[] = []

    constructor(readonly app: ViewerApp, readonly canvas: HTMLCanvasElement, view: MapView | null, follow: boolean, readonly events: {
        onView(view: MapView): void
        onFollow(follow: boolean): void
        onStatus(status: { info: string; problem: string }): void
    }) {
        this.#view = view ?? { centerX: 0, centerY: 0, metersPerPixel: DEFAULT_METERS_PER_PIXEL }
        this.#fitted = !!view
        this.#follow = follow
        this.#dispose.push(app.viewer.onFrame(() => this.#eachFrame()))
        const theme = () => {
            this.#palette = themePalette()
            this.#rebuildGrid()
            this.#rebuildCloud()
            this.requestDraw()
        }
        addEventListener("dim-theme", theme)
        this.#dispose.push(() => removeEventListener("dim-theme", theme))
        const resize = new ResizeObserver(() => this.requestDraw())
        resize.observe(canvas)
        this.#dispose.push(() => resize.disconnect())
        // a browser zoom or a move to another screen changes the pixel ratio
        const redraw = () => this.requestDraw()
        addEventListener("resize", redraw)
        this.#dispose.push(() => removeEventListener("resize", redraw))
        this.#listen()
        this.requestDraw()
    }

    dispose() {
        cancelAnimationFrame(this.#frameRequest)
        this.#unsubscribe()
        this.#dispose.forEach((stop) => stop())
    }

    setFollow(follow: boolean) {
        this.#follow = follow
        if (follow && this.#robot) {
            this.#setView({ ...this.#view, centerX: this.#robot.x, centerY: this.#robot.y })
        }
    }

    setTopic(topic: Topic | null) {
        if (topic?.key === this.#topic?.key) {
            return
        }
        this.#unsubscribe()
        this.#topic = topic
        this.#grid = this.#gridImage = this.#cloud = this.#cloudImage = null
        this.#cloudFrame = null
        this.#cloudPositions = this.#cloudMatrix = null
        this.#gridPose = null
        this.#setStatus("", topic ? `waiting for ${topic.name}` : "no occupancy grid or point cloud on the bus")
        this.requestDraw()
        if (!topic) {
            return
        }
        const connection = this.app.connection
        if (isGridTopic(topic)) {
            this.#stop.push(connection.subscribe(topic.key, { delivery: "latest", maxHz: 2 }, (message) => {
                let grid: LcmValue
                try {
                    grid = decode(topic.type, message.bytes)
                } catch (error) {
                    this.#setStatus(this.#info, `cannot decode ${topic.name}: ${error}`)
                    return
                }
                const { width, height, resolution, origin } = grid.info ?? {}
                if (!width || !height || !(resolution > 0) || !grid.data || grid.data.length < width * height) {
                    this.#setStatus(this.#info, `${topic.name}: empty or truncated grid`)
                    return
                }
                this.#grid = { width, height, resolution, origin, data: grid.data, frame: grid.header?.frame_id ?? "" }
                this.#rebuildGrid()
                this.#gridPose = null
                this.#setStatus(`${width}×${height} @ ${resolution.toFixed(2)} m`, "")
                this.requestDraw()
            }))
            return
        }
        // a cloud: its frame from one raw message (the compact encoding drops the header), then 1 Hz compact clouds
        let frameStop: (() => void) | null = connection.subscribe(topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
            this.#cloudFrame = headerFrameId(topic.type, message.bytes) ?? ""
            frameStop?.()
            frameStop = null
        })
        this.#stop.push(() => frameStop?.())
        this.#stop.push(connection.subscribe(topic.key, { delivery: "latest", maxHz: 1, encoding: "dimos_lcm_pointcloud2" }, (message) => {
            const positions = (message.decoded as { positions?: Float32Array } | undefined)?.positions
            if (!positions || this.#cloudFrame === null) {
                return
            }
            const placed = this.app.tf.lookup(this.#cloudFrame, this.app.viewer.fixedFrame)
            if (!placed) {
                this.#setStatus(this.#info, `no TF from "${this.#cloudFrame}" to "${this.app.viewer.fixedFrame}"`)
                return
            }
            this.#cloud = projectCloud(positions, placed.elements, this.#palette.cloudLow, this.#palette.cloudHigh)
            this.#cloudPositions = positions
            this.#cloudMatrix = placed.elements.slice()
            this.#rebuildCloud()
            this.#setStatus(`${Math.round(positions.length / 3).toLocaleString()} pts · top-down`, "")
            this.requestDraw()
        }))
    }

    /** the last cloud, kept to recolor it on a theme change */
    #cloudPositions: Float32Array | null = null
    #cloudMatrix: number[] | null = null

    #unsubscribe() {
        this.#stop.forEach((stop) => stop())
        this.#stop = []
    }

    #setStatus(info: string, problem: string) {
        this.#info = info
        this.#problem = problem
        this.events.onStatus({ info, problem })
    }

    #rebuildGrid() {
        const grid = this.#grid
        if (!grid) {
            return
        }
        this.#gridPixels = gridPixels(grid.data, grid.width, grid.height, this.#palette.gridLut, this.#gridPixels)
        this.#gridImage = toCanvas(this.#gridPixels, grid.width, grid.height, this.#gridImage)
    }

    #rebuildCloud() {
        if (this.#cloudPositions && this.#cloudMatrix && this.#cloud) {
            this.#cloud = projectCloud(this.#cloudPositions, this.#cloudMatrix, this.#palette.cloudLow, this.#palette.cloudHigh)
        }
        if (this.#cloud) {
            this.#cloudImage = toCanvas(this.#cloud.pixels, this.#cloud.width, this.#cloud.height, this.#cloudImage)
        }
    }

    /** every 3D frame: the robot's pose, the grid's TF placement, the fixed frame; a redraw only when one changed */
    #eachFrame() {
        const fixedFrame = this.app.viewer.fixedFrame
        if (fixedFrame !== this.#fixedFrame) {
            this.#fixedFrame = fixedFrame
            this.#trail.clear()
            this.#gridPose = null
            this.requestDraw()
        }
        const matrix = this.app.robotMatrix
        const robot = matrix ? floorPose(matrix.elements) : null
        const old = this.#robot
        if (!robot !== !old || (robot && old && (Math.abs(robot.x - old.x) > POSE_EPSILON || Math.abs(robot.y - old.y) > POSE_EPSILON || Math.abs(robot.yaw - old.yaw) > YAW_EPSILON))) {
            this.#robot = robot
            if (robot) {
                this.#trail.push(robot.x, robot.y)
                if (this.#follow) {
                    this.#view = { ...this.#view, centerX: robot.x, centerY: robot.y }
                }
                if (!this.#fitted && !this.#grid && !this.#cloud) {
                    this.#view = { ...this.#view, centerX: robot.x, centerY: robot.y }
                }
            }
            this.requestDraw()
        }
        if (this.#grid) {
            const placed = this.app.tf.lookup(this.#grid.frame, fixedFrame)
            if (!placed) {
                if (this.#gridPose) {
                    this.#gridPose = null
                    this.requestDraw()
                }
                if (!this.#problem) {
                    this.#setStatus(this.#info, `no TF from "${this.#grid.frame}" to "${fixedFrame}"`)
                }
                return
            }
            const pose = floorPose(placed.clone().multiply(poseMatrix(this.#grid.origin)).elements)
            const before = this.#gridPose
            if (!before || Math.abs(before.x - pose.x) > 1e-4 || Math.abs(before.y - pose.y) > 1e-4 || Math.abs(before.yaw - pose.yaw) > 1e-5) {
                this.#gridPose = pose
                if (this.#problem.startsWith("no TF")) {
                    this.#setStatus(this.#info, "")
                }
                this.requestDraw()
            }
        }
    }

    /** the drawn data's box in the fixed frame, or null */
    #bounds(): [number, number, number, number] | null {
        if (this.#grid && this.#gridPose) {
            const { width, height, resolution } = this.#grid, { x, y, yaw } = this.#gridPose
            const cos = Math.cos(yaw), sin = Math.sin(yaw)
            const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([u, v]) => [x + (u * cos - v * sin) * resolution, y + (u * sin + v * cos) * resolution])
            return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))]
        }
        if (this.#cloud) {
            const { originX, originY, width, height, cell } = this.#cloud
            return [originX, originY, originX + width * cell, originY + height * cell]
        }
        return null
    }

    /** Shows all of the map (and stops following, unless the robot is the only thing there is). */
    fit() {
        const bounds = this.#bounds()
        const box = this.canvas.getBoundingClientRect()
        if (bounds) {
            if (this.#follow) {
                this.#follow = false
                this.events.onFollow(false)
            }
            this.#setView(fitView(bounds, box.width, box.height))
        } else if (this.#robot) {
            this.#setView({ centerX: this.#robot.x, centerY: this.#robot.y, metersPerPixel: DEFAULT_METERS_PER_PIXEL })
        }
    }

    #setView(view: MapView) {
        this.#view = view
        this.#fitted = true
        this.requestDraw()
        this.#saveView()
    }

    #saveTimer = 0
    #saveView() {
        clearTimeout(this.#saveTimer)
        this.#saveTimer = setTimeout(() => this.events.onView(this.#view), 400) as unknown as number
    }

    requestDraw() {
        if (!this.#frameRequest) {
            this.#frameRequest = requestAnimationFrame(() => {
                this.#frameRequest = 0
                this.#draw()
            })
        }
    }

    #listen() {
        const canvas = this.canvas
        const wheel = (event: WheelEvent) => {
            event.preventDefault()
            const box = canvas.getBoundingClientRect()
            const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
            this.#zoom(Math.exp(-event.deltaY * lines * 0.0015), event.clientX - box.left, event.clientY - box.top)
        }
        const down = (event: PointerEvent) => {
            canvas.setPointerCapture(event.pointerId)
            this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
            this.#dragged = false
        }
        const move = (event: PointerEvent) => {
            const before = this.#pointers.get(event.pointerId)
            if (!before) {
                return
            }
            const box = canvas.getBoundingClientRect()
            const others = [...this.#pointers.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point)
            if (others.length) {
                // pinch: zoom by the change in spread around the other finger, pan by the midpoint's move
                const other = others[0]
                const spreadBefore = Math.hypot(before.x - other.x, before.y - other.y), spreadAfter = Math.hypot(event.clientX - other.x, event.clientY - other.y)
                const middleX = (event.clientX + other.x) / 2 - box.left, middleY = (event.clientY + other.y) / 2 - box.top
                this.#stopFollowing()
                let view = pan(this.#view, (event.clientX - before.x) / 2, (event.clientY - before.y) / 2)
                if (spreadBefore > 10) {
                    view = zoomAt(view, box.width, box.height, middleX, middleY, spreadAfter / spreadBefore)
                }
                this.#setView(view)
            } else {
                const dx = event.clientX - before.x, dy = event.clientY - before.y
                if (!this.#dragged && Math.hypot(dx, dy) < 3) {
                    return
                }
                this.#dragged = true
                this.#stopFollowing()
                this.#setView(pan(this.#view, dx, dy))
            }
            this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
        }
        const up = (event: PointerEvent) => {
            this.#pointers.delete(event.pointerId)
        }
        const doubleClick = () => this.fit()
        canvas.addEventListener("wheel", wheel, { passive: false })
        canvas.addEventListener("pointerdown", down)
        canvas.addEventListener("pointermove", move)
        canvas.addEventListener("pointerup", up)
        canvas.addEventListener("pointercancel", up)
        canvas.addEventListener("dblclick", doubleClick)
        this.#dispose.push(() => {
            canvas.removeEventListener("wheel", wheel)
            canvas.removeEventListener("pointerdown", down)
            canvas.removeEventListener("pointermove", move)
            canvas.removeEventListener("pointerup", up)
            canvas.removeEventListener("pointercancel", up)
            canvas.removeEventListener("dblclick", doubleClick)
        })
    }

    #stopFollowing() {
        if (this.#follow) {
            this.#follow = false
            this.events.onFollow(false)
        }
    }

    /** zooms about a point; following, about the robot (so it stays centered) */
    #zoom(factor: number, sx: number, sy: number) {
        const box = this.canvas.getBoundingClientRect()
        if (this.#follow && this.#robot) {
            ;[sx, sy] = worldToScreen(this.#view, box.width, box.height, this.#robot.x, this.#robot.y)
        }
        this.#setView(zoomAt(this.#view, box.width, box.height, sx, sy, factor))
    }

    #draw() {
        const canvas = this.canvas
        const box = canvas.getBoundingClientRect()
        const width = box.width, height = box.height
        if (width < 2 || height < 2) {
            return
        }
        const ratio = globalThis.devicePixelRatio || 1
        const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio)
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth
            canvas.height = pixelHeight
        }
        // first data with nothing remembered: show all of it
        if (!this.#fitted && this.#bounds()) {
            const bounds = this.#bounds()!
            this.#view = this.#follow && this.#robot ? { centerX: this.#robot.x, centerY: this.#robot.y, metersPerPixel: fitView(bounds, width, height).metersPerPixel } : fitView(bounds, width, height)
            this.#fitted = true
        }
        const context = canvas.getContext("2d")!
        const palette = this.#palette
        const view = this.#view
        const scale = 1 / view.metersPerPixel
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.fillStyle = css(palette.background)
        context.fillRect(0, 0, pixelWidth, pixelHeight)
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        const toScreen = (x: number, y: number) => worldToScreen(view, width, height, x, y)

        // a faint meter grid at the scale bar's step
        const step = niceLength(80 * view.metersPerPixel)
        context.strokeStyle = css(palette.fg, 0.06)
        context.lineWidth = 1
        context.beginPath()
        const [left, top] = [view.centerX - (width / 2) * view.metersPerPixel, view.centerY + (height / 2) * view.metersPerPixel]
        for (let x = Math.ceil(left / step) * step; x < left + width * view.metersPerPixel; x += step) {
            const sx = Math.round(toScreen(x, 0)[0]) + 0.5
            context.moveTo(sx, 0)
            context.lineTo(sx, height)
        }
        for (let y = Math.floor(top / step) * step; y > top - height * view.metersPerPixel; y -= step) {
            const sy = Math.round(toScreen(0, y)[1]) + 0.5
            context.moveTo(0, sy)
            context.lineTo(width, sy)
        }
        context.stroke()

        // the map: world → screen (y flipped), then the image's own placement; row 0 lands at the lowest y
        const worldTransform = () => context.setTransform(ratio * scale, 0, 0, -ratio * scale, ratio * (width / 2 - view.centerX * scale), ratio * (height / 2 + view.centerY * scale))
        context.imageSmoothingEnabled = false
        if (this.#grid && this.#gridImage && this.#gridPose) {
            worldTransform()
            context.translate(this.#gridPose.x, this.#gridPose.y)
            context.rotate(this.#gridPose.yaw)
            context.scale(this.#grid.resolution, this.#grid.resolution)
            context.drawImage(this.#gridImage, 0, 0)
        } else if (this.#cloud && this.#cloudImage) {
            worldTransform()
            context.translate(this.#cloud.originX, this.#cloud.originY)
            context.scale(this.#cloud.cell, this.#cloud.cell)
            context.drawImage(this.#cloudImage, 0, 0)
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0)

        // the world's origin: x (red) and y (green), a scale-bar step long but at least 24 px
        const axis = Math.max(24, Math.min(60, step * scale))
        const [ox, oy] = toScreen(0, 0)
        if (ox > -axis && ox < width + axis && oy > -axis && oy < height + axis) {
            drawAxes(context, ox, oy, axis, true)
        }

        // the trail, then the robot on top
        const trail = this.#trail.points
        if (trail.length >= 4) {
            context.strokeStyle = css(palette.primary, 0.85)
            context.lineWidth = 2
            context.lineJoin = "round"
            context.lineCap = "round"
            context.beginPath()
            let pen = false
            for (let index = 0; index < trail.length; index += 2) {
                if (Number.isNaN(trail[index])) {
                    pen = false
                    continue
                }
                const [sx, sy] = toScreen(trail[index], trail[index + 1])
                if (pen) {
                    context.lineTo(sx, sy)
                } else {
                    context.moveTo(sx, sy)
                }
                pen = true
            }
            context.stroke()
        }
        if (this.#robot) {
            const [sx, sy] = toScreen(this.#robot.x, this.#robot.y)
            context.save()
            context.translate(sx, sy)
            // screen y points down: a yaw counter-clockwise in the world is counter-clockwise on screen too
            context.rotate(-this.#robot.yaw)
            context.beginPath()
            context.moveTo(11, 0)
            context.lineTo(-7, 7)
            context.lineTo(-3, 0)
            context.lineTo(-7, -7)
            context.closePath()
            context.fillStyle = css(palette.robot)
            context.strokeStyle = css(palette.background)
            context.lineWidth = 2
            context.stroke()
            context.fill()
            context.restore()
        }

        // corner key (which way +x and +y point) and the scale bar
        drawAxes(context, width - 40, height - 14, 22, false)
        const barMeters = niceLength(110 * view.metersPerPixel)
        const barPixels = barMeters * scale
        context.strokeStyle = css(palette.fg, 0.9)
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(12, height - 16)
        context.lineTo(12, height - 11)
        context.lineTo(12 + barPixels, height - 11)
        context.lineTo(12 + barPixels, height - 16)
        context.stroke()
        context.fillStyle = css(palette.fg, 0.9)
        context.font = "10px ui-monospace, monospace"
        context.textBaseline = "bottom"
        context.fillText(formatMeters(barMeters), 14, height - 15)
    }
}

/** x (red, right) and y (green, up) arrows from (x, y); labeled ones mark the world origin */
function drawAxes(context: CanvasRenderingContext2D, x: number, y: number, length: number, origin: boolean) {
    const arrow = (dx: number, dy: number, color: string, name: string) => {
        context.strokeStyle = color
        context.fillStyle = color
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(x, y)
        context.lineTo(x + dx * length, y + dy * length)
        context.stroke()
        context.beginPath()
        context.moveTo(x + dx * (length + 5), y + dy * (length + 5))
        context.lineTo(x + dx * length - dy * 4, y + dy * length + dx * 4)
        context.lineTo(x + dx * length + dy * 4, y + dy * length - dx * 4)
        context.closePath()
        context.fill()
        context.font = "600 10px ui-sans-serif, sans-serif"
        context.textBaseline = "middle"
        context.fillText(name, x + dx * (length + 12) - (dx ? 0 : 3), y + dy * (length + 12))
    }
    arrow(1, 0, "#e5484d", origin ? "x" : "+x")
    arrow(0, -1, "#46a758", origin ? "y" : "+y")
}

/** RGBA pixels on a canvas the map draws scaled (reused when the size matches). */
function toCanvas(pixels: Uint8ClampedArray, width: number, height: number, reuse: HTMLCanvasElement | null): HTMLCanvasElement {
    const canvas = reuse && reuse.width === width && reuse.height === height ? reuse : document.createElement("canvas")
    if (canvas !== reuse) {
        canvas.width = width
        canvas.height = height
    }
    canvas.getContext("2d")!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
    return canvas
}
