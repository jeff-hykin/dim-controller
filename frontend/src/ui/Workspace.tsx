// The workspace in React: the arrangement (ui/workspace.ts) for the panels there are now, the boxes it gives them in
// this window, and the one set of panel actions the headers, the palette and the keyboard share. <WorkspaceSurface>
// draws what isn't a panel: the splitters, the rails' edges, the landing preview while a header is dragged, the empty
// main view's hint and, on a phone, the drawer's backdrop.
import { createContext, type PointerEvent as ReactPointerEvent, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react"
import { persistentStore, Store, useStore } from "../core/store.ts"
import { type PanelAction } from "./commands.ts"
import { PHONE_LANDSCAPE } from "./useMobile.ts"
import { startHeaderDrag, startPointerDrag } from "./panelDrag.ts"
import { Button } from "dimos-react"
import { Icon } from "./icons.tsx"
import {
    arrange,
    type Arrangement,
    clampFloat,
    closePanel,
    type DropTarget,
    dropTarget,
    floatBoxFor,
    type Frame,
    layoutWorkspace,
    locate,
    movePanel,
    normalizeArrangement,
    placePanel,
    type Placement,
    popOut,
    type Rect,
    resizeRail,
    resizeSplit,
    showPanel,
    type Side,
    stageTarget,
    toggleCollapsed,
    type View,
    workspace,
    workspaceView,
    type WorkspaceLayout, minimizeStage } from "./workspace.ts"

export interface WorkspaceApi {
    arrangement: Arrangement
    layout: WorkspaceLayout
    frame: Frame
    view: View
    mobile: boolean
    ids: string[]
    act: (id: string, action: PanelAction | "show") => void
    /** the header's ×: out of the workspace (a camera's or a plot's list drops it too, by its own close) */
    close: (id: string) => void
    /** opened at a place (the settings drawer's drop zones, the agent) */
    place: (id: string, to: Placement) => void
    startDrag: (id: string, event: ReactPointerEvent, element: HTMLElement) => void
    toggleRail: (side: Side) => void
    toggleFocus: () => void
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null)
export function useWorkspaceApi(): WorkspaceApi {
    const api = useContext(WorkspaceContext)
    if (!api) {
        throw new Error("a panel outside the workspace")
    }
    return api
}

/** the landing preview while a header is dragged (its own store: a drag never re-renders the panels) */
const dragPreview = new Store<{ target: DropTarget | null; stage: Rect | null }>({ target: null, stage: null })

/**
 * The arrangement as a backend setting too (lv.layout.desktop, lv.layout.phone): the agent reads and sets it (GET / PUT
 * api/layout, POST api/layout/panel), every open page of the same kind follows, and a page opened later starts from it.
 */
export const layoutSettings = {
    desktop: persistentStore<{ arrangement: Arrangement | null }>("lv.layout.desktop", { arrangement: null }),
    phone: persistentStore<{ arrangement: Arrangement | null }>("lv.layout.phone", { arrangement: null }),
}

/** The page's arrangement and the backend's kept the same: a change from elsewhere (another page, the agent) is taken,
 * this page's own changes are sent; only a remote change is applied (never a stale remote over a newer local edit). */
function useLayoutSync(mobile: boolean, ids: string[]) {
    const setting = layoutSettings[mobile ? "phone" : "desktop"]
    const remote = useStore(setting).arrangement
    const { arrangement: local } = useStore(workspace)
    // what this page last sent: its echo isn't a change from elsewhere
    const sent = useRef<string | null>(null)
    const idsRef = useRef(ids)
    idsRef.current = ids
    useEffect(() => {
        const text = JSON.stringify(remote)
        if (!remote || typeof remote !== "object" || text === sent.current) {
            return
        }
        sent.current = text
        const next = normalizeArrangement(remote, idsRef.current)
        if (JSON.stringify(next) !== JSON.stringify(normalizeArrangement(workspace.get().arrangement, idsRef.current))) {
            workspace.set({ arrangement: next })
        }
    }, [remote])
    useEffect(() => {
        const text = JSON.stringify(local)
        if (text !== sent.current && text !== JSON.stringify(setting.get().arrangement)) {
            sent.current = text
            setting.set({ arrangement: local })
        }
    }, [local])
}

/** The workspace for these panels: `ids` (every camera and plot panel and the fixed ones). */
export function useWorkspace(ids: string[], mobile: boolean): WorkspaceApi {
    useLayoutSync(mobile, ids)
    const { arrangement: saved } = useStore(workspace)
    const idsKey = ids.join("|")
    const arrangement = useMemo(() => normalizeArrangement(saved, ids), [saved, idsKey])
    // a camera added or gone: the saved arrangement follows
    useEffect(() => {
        if (JSON.stringify(arrangement) !== JSON.stringify(saved)) {
            workspace.set({ arrangement })
        }
    }, [arrangement, saved])
    const view = useStore(workspaceView)
    // focus (desktop): the main view runs to the window's true bottom, under the bar, which goes see-through over it
    const frame = useFrame(mobile, !mobile && view.hide.length === 2)
    const layout = layoutWorkspace(arrangement, frame, view)

    const normalized = (change: (current: Arrangement) => Arrangement) => arrange((current) => change(normalizeArrangement(current, ids)))
    const reveal = (id: string, next: Arrangement) => {
        const zone = locate(next, id)?.zone
        const side: Side | null = zone === "left" || zone === "right" ? zone : null
        const current = workspaceView.get()
        if (mobile) {
            workspaceView.set({ ...current, drawer: side })
        } else if (side && current.hide.includes(side)) {
            workspaceView.set({ ...current, hide: current.hide.filter((other) => other !== side) })
        }
    }
    const toggleFocus = () => {
        const current = workspaceView.get()
        workspaceView.set({ ...current, hide: current.hide.length ? [] : ["left", "right"] })
    }
    const act = (id: string, action: PanelAction | "show") => {
        const current = normalizeArrangement(workspace.get().arrangement, ids)
        if (action === "show") {
            const next = showPanel(current, id)
            normalized(() => next)
            reveal(id, next)
        } else if (action === "collapse") {
            normalized((arrangement) => toggleCollapsed(arrangement, id))
        } else if (action === "main") {
            if (current.stage !== id) {
                normalized((arrangement) => movePanel(arrangement, id, { zone: "stage" }))
                if (mobile) {
                    workspaceView.set({ ...workspaceView.get(), drawer: null })
                }
            }
        } else if (action === "minimize") {
            normalized((arrangement) => minimizeStage(arrangement))
        } else {
            normalized((arrangement) => popOut(arrangement, id, layoutWorkspace(arrangement, frame, workspaceView.get())))
        }
    }
    const startDrag = (id: string, event: ReactPointerEvent, element: HTMLElement) => {
        const current = normalizeArrangement(workspace.get().arrangement, ids)
        // a phone has no rails to drop into: only a floating panel moves, and it stays floating
        if (event.button !== 0 || mobile && !current.floating.some((box) => box.id === id)) {
            return
        }
        const currentView = workspaceView.get()
        const here = layoutWorkspace(current, frame, currentView)
        const rect = here.slots[id]?.rect
        if (!rect) {
            return
        }
        const floating = current.floating.some((box) => box.id === id)
        const size = floating ? { width: rect.width, height: rect.height } : (({ width, height }) => ({ width, height }))(floatBoxFor(current, id, here))
        const grab = { x: Math.max(12, Math.min(size.width - 60, event.clientX - rect.x)), y: Math.max(4, Math.min(28, event.clientY - rect.y)) }
        startHeaderDrag(event, element, {
            size,
            grab,
            target: (pointer, box) => mobile ? { zone: "float", box: clampFloat(box, here.area), preview: clampFloat(box, here.area) } : dropTarget(current, frame, currentView, id, pointer, box),
            preview: (target) => dragPreview.set({ target, stage: target && current.stage !== id ? stageTarget(here.stage) : null }),
            drop: (target) => {
                normalized((arrangement) => movePanel(arrangement, id, target))
                if (target.zone === "left" || target.zone === "right") {
                    reveal(id, movePanel(current, id, target))
                }
            },
        })
    }
    const close = (id: string) => normalized((current) => closePanel(current, id))
    const place = (id: string, to: Placement) => {
        const next = placePanel(normalizeArrangement(workspace.get().arrangement, ids), id, to, frame.width)
        arrange(() => next)
        reveal(id, next)
    }
    const toggleRail = (side: Side) => {
        const current = workspaceView.get()
        if (mobile) {
            workspaceView.set({ ...current, drawer: current.drawer === side ? null : side })
        } else {
            workspaceView.set({ ...current, hide: current.hide.includes(side) ? current.hide.filter((other) => other !== side) : [...current.hide, side] })
        }
    }
    return { arrangement, layout, frame, view, mobile, ids, act, close, place, startDrag, toggleRail, toggleFocus }
}

/** The window as the workspace sees it: above the bar along the bottom (a phone: above the thumb sticks). */
function useFrame(mobile: boolean, underBar: boolean): Frame {
    const [, setTick] = useState(0)
    useEffect(() => {
        const again = () => setTick((tick) => tick + 1)
        addEventListener("resize", again)
        // theme.js sets --dim-inset-* on <html> when Desktop's dock moves
        const insets = new MutationObserver(again)
        insets.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
        const bars = new ResizeObserver(again)
        const watched = new Set<Element>()
        const watch = () => {
            for (const element of document.querySelectorAll(".main-bar, .drive-hud.mobile, .phone-corners")) {
                if (!watched.has(element)) {
                    watched.add(element)
                    bars.observe(element)
                }
            }
        }
        watch()
        const timer = setInterval(watch, 500)
        return () => {
            removeEventListener("resize", again)
            insets.disconnect()
            bars.disconnect()
            clearInterval(timer)
        }
    }, [])
    const root = getComputedStyle(document.documentElement)
    const px = (name: string, fallback: number) => {
        const value = parseFloat(root.getPropertyValue(name))
        return Number.isFinite(value) ? value : fallback
    }
    const height = innerHeight
    // desktop: above the action dock; a phone: above the thumb sticks, so the main view is never under a thumb, except
    // on its side, where the sticks lie over a full-screen main view (a game pad's look)
    const underSticks = mobile && matchMedia(PHONE_LANDSCAPE).matches
    const dock = mobile && !underSticks ? document.querySelector(".drive-hud.mobile")?.getBoundingClientRect().top : undefined
    return {
        width: innerWidth,
        height,
        // a phone: the panels start below its corner buttons; desktop: at the top, down to the bar along the bottom
        top: mobile ? document.querySelector(".phone-corners")?.getBoundingClientRect().bottom ?? 0 : 0,
        bottom: dock ?? (!mobile && !underBar ? document.querySelector(".main-bar")?.getBoundingClientRect().top : undefined) ?? height - px("--dim-inset-bottom", 0),
        mobile,
        gap: px("--lv-panel-gap", 0),
    }
}

/** What's drawn around the panels: splitters, rail edges, the drag preview, the empty stage, a phone's drawer backdrop. */
export function WorkspaceSurface({ emptyStage }: { emptyStage: ReactNode }) {
    const api = useWorkspaceApi()
    const { arrangement, layout, mobile } = api
    const preview = useStore(dragPreview)
    const ids = api.ids
    const splitters: ReactNode[] = []
    if (!mobile) {
        for (const side of ["left", "right"] as const) {
            const rail = layout.rails[side]
            if (!rail) {
                continue
            }
            const members = arrangement[side]
            members.forEach((above, index) => {
                const below = members[index + 1]
                const a = layout.slots[above], b = below ? layout.slots[below] : null
                if (!b || a.collapsed || b.collapsed) {
                    return
                }
                const y = a.rect.y + a.rect.height
                // the panels meet edge to edge: the handle straddles the seam
                splitters.push(
                    <div
                        key={`split-${above}`}
                        className="ws-splitter"
                        role="separator"
                        aria-orientation="horizontal"
                        title="Drag to share the height between these two panels"
                        style={{ left: rail.x, top: y - HANDLE / 2, width: rail.width, height: HANDLE }}
                        onPointerDown={(event) => {
                            const start = normalizeArrangement(workspace.get().arrangement, ids)
                            const startLayout = layoutWorkspace(start, api.frame, workspaceView.get())
                            startPointerDrag(event, (_dx, dy) => arrange(() => resizeSplit(start, above, below, dy, startLayout)))
                        }}
                    />,
                )
            })
            // the rail's inner edge: drag to widen or narrow it
            const edgeX = (side === "left" ? rail.x + rail.width : rail.x) - HANDLE / 2
            splitters.push(
                <div
                    key={`edge-${side}`}
                    className="ws-rail-edge"
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize the rail"
                    style={{ left: edgeX, top: rail.y, width: HANDLE, height: rail.height }}
                    onPointerDown={(event) => {
                        const start = normalizeArrangement(workspace.get().arrangement, ids)
                        const width = rail.width
                        startPointerDrag(event, (dx) => arrange(() => resizeRail(start, side, width + (side === "left" ? dx : -dx))))
                    }}
                />,
            )
        }
    }
    const target = preview.target
    return (
        <>
            {!arrangement.stage && (
                <div className="ws-empty-stage" style={rectStyle(layout.stage)}>{emptyStage}</div>
            )}
            {splitters}
            {target && (
                <>
                    {preview.stage && <div className={`ws-stage-target ${target.zone === "stage" ? "on" : ""}`} style={rectStyle(preview.stage)}><span>Swap into the main view</span></div>}
                    <div className={`ws-drop-preview zone-${target.zone}`} style={rectStyle(target.preview)} />
                    {!layout.rails.left && <div className={`ws-edge-hint left ${target.zone === "left" ? "on" : ""}`} style={{ top: layout.area.y, height: layout.area.height, left: 0 }} />}
                    {!layout.rails.right && <div className={`ws-edge-hint right ${target.zone === "right" ? "on" : ""}`} style={{ top: layout.area.y, height: layout.area.height, right: 0 }} />}
                </>
            )}
            {mobile && layout.drawer && api.view.drawer === "right" && (
                <>
                    <div className="ws-sheet" style={{ ...rectStyle(layout.drawer), top: 0, height: layout.drawer.y + layout.drawer.height }} />
                    <div className="ws-sheet-head" style={{ height: layout.drawer.y }}>
                        <Button className="ws-sheet-back" onClick={() => workspaceView.set({ ...workspaceView.get(), drawer: null })} data-testid="sheet-back">
                            <Icon name="chevron-left" size={18} />Back
                        </Button>
                    </div>
                </>
            )}
            {mobile && layout.drawer && api.view.drawer === "left" && (
                <>
                    <div className="ws-scrim" onClick={() => workspaceView.set({ ...workspaceView.get(), drawer: null })} />
                    <div className={`ws-drawer ${api.view.drawer}`} style={rectStyle(layout.drawer)} />
                </>
            )}
        </>
    )
}

/** how thick a splitter's or a rail edge's grab handle is, centred on the seam between two panels */
const HANDLE = 8

export const rectStyle = (rect: Rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

/** a box clamped to the workspace (a floating panel resized by its corner) */
export function clampToArea(box: Rect, layout: WorkspaceLayout): Rect {
    return clampFloat(box, layout.area)
}
