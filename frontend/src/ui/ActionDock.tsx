// The action dock along the bottom (desktop): the drive keys lighting up as they're held with what's being sent (or
// the hold and Reconnect), the actions used while driving, the palette, and STOP, always in the same corner. On a
// phone the dock is the two thumb sticks with STOP between them (ui/DriveHud.tsx).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { scenePanel, updateScenePanel } from "../core/cloudQuality.ts"
import { ArmHud } from "./ArmHud.tsx"
import { DriveKeys } from "./DriveHud.tsx"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import type { WorkspaceApi } from "./Workspace.tsx"

export function ActionDock({ app, api, canDrive }: { app: ViewerApp; api: WorkspaceApi; canDrive: boolean }) {
    useStore(app.robot)
    const scene = useStore(scenePanel)
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
                <button type="button" className="dim-btn sm dock-action" title="3D view: follow the robot again" onClick={() => app.recenter()}><Icon name="target" size={15} /><span>Recenter</span></button>
                <button type="button" className="dim-btn sm dock-action" title="3D view: straight down" onClick={() => app.topDown()}><Icon name="top" size={15} /><span>Top-down</span></button>
                <button type="button" className={`dim-btn sm dock-action ${scene.off ? "" : "on"}`} aria-pressed={!scene.off} title={scene.off ? "Turn the 3D view on (subscribes again)" : "Turn the 3D view off (no bandwidth)"} onClick={() => updateScenePanel({ off: !scene.off })}><Icon name="cube" size={15} /><span>3D {scene.off ? "off" : "on"}</span></button>
                <button type="button" className={`dim-btn sm dock-action ${focused ? "on" : ""}`} aria-pressed={focused} title="Focus the main view: hide both rails (\\)" onClick={api.toggleFocus}><Icon name={focused ? "fullscreen-exit" : "fullscreen"} size={15} /><span>Focus</span></button>
                <button type="button" className="dim-btn sm dock-action" title="Every action, searchable (/)" onClick={() => openOverlay("palette")}><Icon name="search" size={15} /><span>All actions</span><kbd className="lv-kbd">/</kbd></button>
            </div>
            <button type="button" className="dim-btn dock-stop" data-testid="stop-button" title="Stop now (Space, always)" onPointerDown={stop} onClick={stop}>
                <span>STOP</span>
                <kbd className="lv-kbd">Space</kbd>
            </button>
        </footer>
    )
}
