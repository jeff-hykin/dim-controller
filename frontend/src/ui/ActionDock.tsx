// The action dock along the bottom (desktop): the drive keys lighting up as they're held with what's being sent (or
// the hold and Reconnect), the main view's own actions (ui/dockActions.ts: a camera's, the 3D view's or the map's),
// focus, the palette, and STOP, always in the same corner. On a phone the dock is the two thumb sticks with STOP
// between them (ui/DriveHud.tsx).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { dockActions, dockActionsFor } from "./dockActions.ts"
import { ArmHud } from "./ArmHud.tsx"
import { DriveKeys } from "./DriveHud.tsx"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import type { WorkspaceApi } from "./Workspace.tsx"

export function ActionDock({ app, api, canDrive }: { app: ViewerApp; api: WorkspaceApi; canDrive: boolean }) {
    useStore(app.robot)
    const actions = dockActionsFor(useStore(dockActions), api.arrangement.stage)
    const arm = app.profile.type === "arm"
    const focused = api.view.hide.length === 2
    const stop = () => (arm ? app.arm.stop() : app.drive.stop())
    return (
        <footer className="action-dock" data-testid="action-dock">
            <div className="dock-group dock-drive-slot">
                {!canDrive
                    ? <span className="hint dock-note">Nothing to drive yet: the message above says what's missing.</span>
                    : arm
                    ? <ArmHud app={app} mobile={false} />
                    : <DriveKeys app={app} />}
            </div>
            <div className="dock-group dock-actions" role="toolbar" aria-label="Actions">
                {actions.map((action) => (
                    <button
                        key={action.id}
                        type="button"
                        className={`dim-btn sm dock-action main-action ${action.pressed ? "on" : ""}`}
                        data-action={action.id}
                        aria-pressed={action.pressed}
                        title={action.title}
                        onClick={action.run}
                    >
                        <Icon name={action.icon} size={15} />
                        <span>{action.label}</span>
                    </button>
                ))}
                <button type="button" className={`dim-btn sm dock-action ${focused ? "on" : ""}`} aria-pressed={focused} title="Focus the main view: hide both rails (\\)" onClick={api.toggleFocus}><Icon name={focused ? "fullscreen-exit" : "fullscreen"} size={15} /><span>Focus</span></button>
                <button type="button" className="dim-btn sm dock-action" title="Every action, searchable (/)" onClick={() => openOverlay("palette")}><Icon name="search" size={15} /><span>All actions</span><kbd className="lv-kbd">/</kbd></button>
            </div>
            <div className="dock-stop-slot">
                <button type="button" className="dim-btn dock-stop" data-testid="stop-button" title="Stop now (Space, always)" onPointerDown={stop} onClick={stop}>
                    <span>STOP</span>
                    <kbd className="lv-kbd">Space</kbd>
                </button>
            </div>
        </footer>
    )
}
