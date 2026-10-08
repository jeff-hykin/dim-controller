// The Sim panel: while a DimSim run is up (`simulation: dimsim`), DimSim's own live 3D page in a floating panel. With
// `dimsim_headless: false` dimos waits for that page to be open somewhere (it's what renders the sensors), and this
// panel is that page: it stays loaded while the run is up, folded to a small preview rather than closed, since a
// closed one would stop the camera and lidar. Headless, dimos already has the page open in its own browser, and a second
// copy would re-seed the bridge's physics and publish the sensors twice (every page's sensor socket is relayed; DimSim's
// cli/bridge/server.ts), so the panel only says so; for the same reason it never offers "open in a new tab", and only one
// Controller tab in a browser shows it (a Web Lock; "Show it here" takes it over), and a phone shows it only when asked.
// MuJoCo has
// no page (its viewer is a native window): the 3D view draws the robot's own model (core/render/simModel.ts).
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { dimsimUrl } from "../core/sim.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { Icon } from "./icons.tsx"
import { clampPanelBox, type PanelBox, startPanelDrag } from "./panelDrag.ts"

export const SIM_LAYOUT_KEY = "lv.simview"
const MINIMUM = { width: 220, height: 150 }

interface SimLayout extends PanelBox {
    /** a small preview (still loaded: see above) */
    folded: boolean
    /** fills the area under the top bar */
    full: boolean
}

const viewport = () => ({ width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 })

export function loadSimLayout(saved: Partial<SimLayout> = readLocal<Partial<SimLayout>>(SIM_LAYOUT_KEY, {}), screen = viewport()): SimLayout {
    const defaults: SimLayout = { folded: false, full: false, x: -1, y: -1, width: 480, height: 330 }
    return {
        ...clampPanelBox(saved ?? {}, defaults, screen, MINIMUM),
        folded: typeof saved?.folded === "boolean" ? saved.folded : false,
        full: typeof saved?.full === "boolean" ? saved.full : false,
    }
}

export function SimPanel({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const { sim } = useStore(app.runs.state)
    const [layout, setLayout] = useState(() => loadSimLayout())
    const update = (patch: Partial<SimLayout>) =>
        setLayout((old) => {
            const next = { ...old, ...patch }
            writeLocal(SIM_LAYOUT_KEY, next)
            return next
        })
    const element = useRef<HTMLDivElement>(null)
    const [, setViewport] = useState(viewport)
    useEffect(() => {
        const resized = () => setViewport(viewport())
        addEventListener("resize", resized)
        return () => removeEventListener("resize", resized)
    }, [])

    const url = sim ? dimsimUrl(sim, location) : null
    const wanted = !!url && !!sim?.dimsim && !sim.dimsim.headless
    const claim = useSimClaim(wanted ? url : null, !mobile)
    if (!sim || !url || !sim.dimsim) {
        return null
    }
    const embedded = wanted && claim.here

    const startDrag = (event: ReactPointerEvent) => {
        if (layout.full || mobile || (event.target as HTMLElement).closest("button")) {
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
            width = Math.round(Math.max(MINIMUM.width, Math.min(innerWidth - box.left - 8, box.width + moved.clientX - startX)))
            height = Math.round(Math.max(MINIMUM.height, Math.min(innerHeight - box.top - 8, box.height + moved.clientY - startY)))
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

    const box = clampPanelBox(layout, layout, viewport(), MINIMUM)
    const placed = box.x >= 0 ? { left: box.x, top: box.y } : {}
    const full = layout.full && !layout.folded
    const style: React.CSSProperties = mobile || full ? {} : layout.folded ? placed : { ...placed, width: box.width, height: box.height }
    const where = `DimSim · ${sim.dimsim.scene} · :${sim.dimsim.port}`
    return (
        <div className="sim-layer">
            <div ref={element} data-testid="sim-panel" className={`dim-panel camera-panel sim-panel ${layout.folded ? "folded" : "open"} ${full ? "main" : ""} ${box.x < 0 ? "default-spot" : ""}`} style={style}>
                <div className="camera-head" onPointerDown={startDrag} onDoubleClick={(event) => !mobile && !(event.target as HTMLElement).closest("button") && update({ full: !layout.full, folded: false })} title={`${sim.blueprint}: ${where}`}>
                    <span className="sim-title"><Icon name="cube" size={14} />Sim</span>
                    <span className="camera-info">{where}</span>
                    {!mobile && !layout.folded && (
                        <button type="button" className="dim-btn icon icon-button" onClick={() => update({ full: !layout.full })} title={full ? "Back to a panel" : "Fill the window"} aria-label={full ? "Restore" : "Fill the window"}>
                            <Icon name={full ? "fullscreen-exit" : "fullscreen"} size={14} />
                        </button>
                    )}
                    <button type="button" className="dim-btn icon icon-button" onClick={() => update({ folded: !layout.folded, full: false })} title={layout.folded ? "Show it bigger" : "Fold to a small preview (it stays loaded: the sim's sensors need the page)"} aria-label={layout.folded ? "Unfold" : "Fold"}>
                        <Icon name={layout.folded ? "chevron-down" : "chevron-up"} size={14} />
                    </button>
                </div>
                <div className="camera-body sim-body">
                    {embedded
                        ? <iframe className="sim-frame" src={url} title="DimSim" allow="fullscreen; gamepad; xr-spatial-tracking" />
                        : wanted ? (
                            <div className="sim-note">
                                {claim.elsewhere ? "DimSim's page is open in another Controller tab." : "DimSim's page isn't open on this device."} It renders the sim's
                                camera and lidar, so only one copy should be open at a time.
                                <button type="button" className="dim-btn" onClick={claim.take}>Show it here</button>
                            </div>
                        ) : (
                            <div className="sim-note">
                                DimSim is running headless: dimos has its page open in its own browser, and a second copy would restart its physics and
                                publish the camera and lidar twice. Launch with <code>dimsim_headless: false</code> to watch it here.
                            </div>
                        )}
                </div>
                {!mobile && !full && !layout.folded && <div className="camera-resize right" title="Drag to resize" aria-label="Resize" onPointerDown={startResize} />}
            </div>
        </div>
    )
}

/**
 * Whether this page shows DimSim's page: one Controller tab per browser holds the `dimsim-view` Web Lock while it
 * does. `auto` queues for it (so it takes over when the tab that has it closes); `take` steals it (the tab that had it
 * lets go and queues again behind).
 */
function useSimClaim(url: string | null, auto: boolean): { here: boolean; elsewhere: boolean; take: () => void } {
    const [state, setState] = useState({ here: false, elsewhere: false })
    const current = useRef<{ abort: AbortController; release: () => void } | null>(null)
    const stop = () => {
        current.current?.abort.abort()
        current.current?.release()
        current.current = null
    }
    const request = (steal: boolean) => {
        const locks = globalThis.navigator?.locks
        if (!locks) {
            setState({ here: true, elsewhere: false })
            return
        }
        stop()
        const abort = new AbortController()
        let release = () => {}
        const held = new Promise<void>((resolve) => release = resolve)
        current.current = { abort, release }
        locks.query().then((snapshot) => {
            if (!abort.signal.aborted && !steal && snapshot.held?.some((lock) => lock.name === "dimsim-view")) {
                setState({ here: false, elsewhere: true })
            }
        }).catch(() => {})
        locks.request("dimsim-view", steal ? { steal: true } : { signal: abort.signal }, () => {
            if (abort.signal.aborted) {
                return
            }
            setState({ here: true, elsewhere: false })
            return held
        }).then(() => {
            // let go (closed, or another tab stole it): queue again unless this page is done with it
            if (current.current?.abort === abort && !abort.signal.aborted) {
                setState({ here: false, elsewhere: true })
                request(false)
            }
        }, () => {
            if (current.current?.abort === abort && !abort.signal.aborted) {
                setState({ here: false, elsewhere: true })
                request(false)
            }
        })
    }
    useEffect(() => {
        if (!url) {
            setState({ here: false, elsewhere: false })
            return
        }
        if (auto) {
            request(false)
        }
        return () => {
            stop()
            setState({ here: false, elsewhere: false })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, auto])
    return { ...state, take: () => request(true) }
}
