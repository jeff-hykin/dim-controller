// The top bar's Settings button opens this over a dimmed main view: on the left a column of panel thumbnails (Camera,
// 3D view, 2D Map, Plot, Settings), each with a count of the streams it could show that nothing shows; on the right the
// settings list. A click on a thumbnail, or a drag of it, shows the places it can go as outlined, named zones: each
// panel on screen split in half (or the empty main view); a click on a zone, or a drop on one, opens it there.
// Escape, or a click outside the zones, puts it back. Desktop only (a phone keeps its own panel list).
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { Store, useStore } from "../core/store.ts"
import { Button } from "dimos-react"
import { Icon } from "./icons.tsx"
import { rectStyle, type WorkspaceApi } from "./Workspace.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"
import { addCameraPanel, cameraLayout, cameraPanels } from "./CameraPanels.tsx"
import { addPlot, plotLayout, plotsOf } from "./PlotPanel.tsx"
import { kindOf, PANEL_KINDS, type PanelKind, type Shown, unshownStreams } from "./panelCatalog.ts"
import { homeOf, type Rect, splitZones, type SplitZone } from "./workspace.ts"
import { panelTitle } from "./commands.ts"
import { DRAG_SLOP } from "./panelDrag.ts"

/** the drawer's state: open, or a kind being placed (picked by a click, or dragged with the pointer at `pointer`) */
export const settingsDrawer = new Store<{ open: boolean; placing: PanelKind | null; pointer: { x: number; y: number } | null }>({ open: false, placing: null, pointer: null })

export const openSettingsDrawer = () => settingsDrawer.set({ open: true, placing: null, pointer: null })
const closeDrawer = () => settingsDrawer.set({ open: false, placing: null, pointer: null })

/** What the open panels show (the thumbnails' and the Settings button's counts). */
export function useShown(api: WorkspaceApi): Shown {
    const cameras = cameraPanels(useStore(cameraLayout))
    const plots = plotsOf(useStore(plotLayout))
    const placed = Object.keys(api.layout.slots)
    const key = placed.join("|")
    return useMemo(() => ({
        open: new Set(placed.map(kindOf).filter((kind): kind is PanelKind => kind !== null)),
        cameraKeys: new Set(cameras.filter((panel) => placed.includes(`camera:${panel.id}`)).map((panel) => panel.key)),
        plottedKeys: new Set(plots.filter((plot) => placed.includes(`plot:${plot.id}`)).flatMap((plot) => plot.series.map((series) => series.key))),
    }), [key, cameras, plots])
}

/** a zone's name: "Main view", or the panel it splits and which half ("Left of Camera", "Below 2D Map") */
const zoneName = (zone: SplitZone) => zone.of ? `${zone.title} ${panelTitle(zone.of)}` : zone.title

/** a zone drawn a little inside the half it stands for, so two halves of one panel read as two */
const inset = (rect: Rect, by = 6): Rect => ({ x: rect.x + by, y: rect.y + by, width: Math.max(0, rect.width - 2 * by), height: Math.max(0, rect.height - 2 * by) })

export function SettingsDrawer({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const state = useStore(settingsDrawer)
    const { topics } = useStore(app.connection.status)
    const shown = useShown(api)
    const [hover, setHover] = useState<string | null>(null)
    useEffect(() => {
        if (!state.open && !state.placing) {
            return
        }
        const escape = (event: KeyboardEvent) => event.key === "Escape" && closeDrawer()
        addEventListener("keydown", escape)
        return () => removeEventListener("keydown", escape)
    }, [state.open, state.placing])
    if (api.mobile || (!state.open && !state.placing)) {
        return null
    }
    const zones = splitZones(api.arrangement, api.layout)
    const place = (kind: PanelKind, zone: SplitZone) => {
        const id = kind === "camera"
            ? addCameraPanel(topics, app.profile.cameras.preferred)
            : kind === "plot"
            ? addPlot()
            : kind
        api.place(id, zone.placement)
        closeDrawer()
    }
    const zoneAt = (point: { x: number; y: number }) =>
        zones.find(({ rect }) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) ?? null
    // a thumbnail pressed: a click picks it (zones to click), a drag carries it (zones to drop on)
    const press = (kind: PanelKind, event: ReactPointerEvent) => {
        if (event.button !== 0) {
            return
        }
        const start = { x: event.clientX, y: event.clientY }
        let dragging = false
        const move = (moved: PointerEvent) => {
            if (!dragging && Math.hypot(moved.clientX - start.x, moved.clientY - start.y) >= DRAG_SLOP) {
                dragging = true
            }
            if (dragging) {
                settingsDrawer.set({ open: false, placing: kind, pointer: { x: moved.clientX, y: moved.clientY } })
                setHover(zoneAt({ x: moved.clientX, y: moved.clientY })?.key ?? null)
            }
        }
        const up = (released: PointerEvent) => {
            removeEventListener("pointermove", move)
            removeEventListener("pointerup", up)
            if (!dragging) {
                settingsDrawer.set({ open: false, placing: kind, pointer: null })
                return
            }
            const zone = zoneAt({ x: released.clientX, y: released.clientY })
            setHover(null)
            if (zone) {
                place(kind, zone)
            } else {
                openSettingsDrawer()
            }
        }
        addEventListener("pointermove", move)
        addEventListener("pointerup", up)
    }
    if (state.placing) {
        const kind = PANEL_KINDS.find((one) => one.kind === state.placing)!
        return (
            <div className="drop-zones" data-testid="drop-zones" onClick={closeDrawer} style={rectStyle(api.layout.area)}>
                {zones.map((zone) => {
                    const rect = inset(zone.rect)
                    return (
                    <button
                        type="button"
                        key={zone.key}
                        className={`drop-zone ${hover === zone.key ? "on" : ""}`}
                        data-zone={zone.key}
                        style={{ ...rectStyle(rect), left: rect.x - api.layout.area.x, top: rect.y - api.layout.area.y }}
                        onPointerEnter={() => setHover(zone.key)}
                        onPointerLeave={() => setHover(null)}
                        onClick={(event) => {
                            event.stopPropagation()
                            place(kind.kind, zone)
                        }}
                    >
                        <span className="drop-zone-title">{zoneName(zone)}</span>
                    </button>
                    )
                })}
                {state.pointer
                    ? <div className="drop-ghost" style={{ left: state.pointer.x - api.layout.area.x - 70, top: state.pointer.y - api.layout.area.y - 30 }}><Icon name={kind.icon} size={22} /><span>{kind.title}</span></div>
                    : <div className="drop-hint">Where should the {kind.title.toLowerCase()} go? <span className="dim">Esc to cancel</span></div>}
            </div>
        )
    }
    const sideWidth = homeOf("settings").float.width
    return (
        <>
            <div className="drawer-scrim" data-testid="drawer-scrim" style={rectStyle(api.layout.area)} onClick={closeDrawer} />
            <aside className="settings-drawer left" data-testid="panel-drawer" style={{ ...rectStyle(api.layout.area), width: 320 }} aria-label="Add a panel">
                <h3 className="drawer-head">Click or drag a panel</h3>
                <div className="panel-thumbs">
                    {PANEL_KINDS.map(({ kind, title, icon }) => {
                        const count = unshownStreams(kind, topics, shown).length
                        return (
                            <button type="button" key={kind} className="panel-thumb" data-kind={kind} onPointerDown={(event) => press(kind, event)} title={count ? `${count} stream${count === 1 ? "" : "s"} it could show that no panel shows` : `${title}: ${PANEL_KINDS.find((one) => one.kind === kind)!.about}`}>
                                {count > 0 && <span className="count-badge" data-testid="thumb-badge">{count}</span>}
                                <span className={`panel-thumb-pic thumb-${kind}`}><Icon name={icon} size={30} /></span>
                                <span className="panel-thumb-title">{title}</span>
                            </button>
                        )
                    })}
                </div>
            </aside>
            <aside className="settings-drawer right" data-testid="settings-drawer" style={{ ...rectStyle(api.layout.area), left: api.layout.area.x + api.layout.area.width - Math.max(sideWidth, 380), width: Math.max(sideWidth, 380) }} aria-label="Settings">
                <div className="drawer-head-row">
                    <h3 className="drawer-head">Settings</h3>
                    <Button className="dr-btn--icon" aria-label="Close settings" title="Close (Esc)" onClick={closeDrawer}><Icon name="close" size={14} /></Button>
                </div>
                <div className="drawer-body panel-body"><SettingsPanel app={app} /></div>
            </aside>
        </>
    )
}
