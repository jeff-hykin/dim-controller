// The drive keys over the bottom of the main view, only while one is held (no numbers): Shift on the left of
// Q W E / A S D, the held ones lit. An arm shows its end-effector keys the same way. Desktop only.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profileAxes } from "../core/gamepad.ts"
import type { Axis } from "../profile/types.ts"
import { ArmHud } from "./ArmHud.tsx"
import type { Rect } from "./workspace.ts"
import { useWorkspaceApi } from "./Workspace.tsx"

export function KeyOverlay({ app, stage }: { app: ViewerApp; stage: Rect }) {
    const state = useStore(app.drive.state)
    const arm = useStore(app.arm.state)
    useStore(app.robot)
    // above the action buttons along the main view's bottom (ui/ActionBar.tsx)
    const place = { left: stage.x + stage.width / 2, bottom: innerHeight - (stage.y + stage.height) + 64 }
    if (app.profile.type === "arm") {
        const active = arm.jogging || Object.values(arm.ee).some((value) => value !== 0)
        return active ? <div className="key-overlay arm" style={place} data-testid="key-overlay"><ArmHud app={app} mobile={false} /></div> : null
    }
    const held = Object.values(state.axes).some((value) => value !== 0) || state.boost
    if (!held) {
        return null
    }
    return <div className="key-overlay" style={place} data-testid="key-overlay"><DriveKeyGrid app={app} lit /></div>
}

/** Shift, then the profile's drive keys in a 3 × 2 grid; `lit` lights the held ones (the empty-view hint draws them unlit). */
export function DriveKeyGrid({ app, lit }: { app: ViewerApp; lit: boolean }) {
    const state = useStore(app.drive.state)
    const keys = app.profile.drive.keys
    const { strafe, vertical } = profileAxes(app.profile)
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const down = (axis: Axis, sign: number) => lit && Math.sign(state.axes[axis]) === sign && state.axes[axis] !== 0
    const cell = (axis: Axis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${down(axis, sign) ? "down" : ""}`}>{key}</span> : <span className="key empty" />
    }
    // the top row's sides: strafe (Q / E) or a drone's up / down; the bottom row's: turn (A / D)
    const side = (sign: number) => strafe ? cell("strafe", sign) : vertical ? cell("vertical", -sign) : <span className="key empty" />
    const top = <>{side(1)}{cell("forward", 1)}{side(-1)}</>
    const bottom = <>{cell("turn", 1)}{cell("forward", -1)}{cell("turn", -1)}</>
    return (
        <div className="drive-key-grid" aria-label="drive keys">
            <span className={`key shift ${lit && state.boost ? "down" : ""}`} title="Shift: fast">⇧</span>
            <div className="drive-key-rows">
                <div>{top}</div>
                <div>{bottom}</div>
            </div>
        </div>
    )
}

/** The controls, taught where there's nothing to look at yet (an empty camera or 3D view): the drive keys with W A S D
 * picked out like arrow keys, a wide Shift "= go fast", and what each does for this format. */
export function DriveHint({ app, waiting }: { app: ViewerApp; waiting: string }) {
    useStore(app.robot)
    const { mobile } = useWorkspaceApi()
    // a phone drives with its thumb sticks: no keys to teach
    if (app.profile.type === "arm" || mobile) {
        return <div className="drive-hint"><p className="drive-hint-waiting"><b>{waiting}</b></p></div>
    }
    const keys = app.profile.drive.keys
    const { strafe, vertical } = profileAxes(app.profile)
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const cell = (axis: Axis, sign: number, arrow: boolean) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${arrow ? "arrow" : ""}`}>{key}</span> : <span className="key empty" />
    }
    const side = (sign: number) => strafe ? cell("strafe", sign, false) : vertical ? cell("vertical", -sign, false) : <span className="key empty" />
    const pair = (axis: Axis) => [keyFor(axis, 1), keyFor(axis, -1)].filter(Boolean).join(" / ")
    return (
        <div className="drive-hint" data-testid="drive-hint">
            <p className="drive-hint-waiting"><b>{waiting}</b></p>
            <div className="drive-hint-keys">
                <div className="drive-key-rows">
                    <div>{side(1)}{cell("forward", 1, true)}{side(-1)}</div>
                    <div>{cell("turn", 1, true)}{cell("forward", -1, true)}{cell("turn", -1, true)}</div>
                </div>
                <span className="key shift wide">⇧ Shift <span className="dim">= go fast</span></span>
            </div>
            <p>Click the view, then {pair("forward")} to drive, {pair("turn")} to turn{strafe ? `, ${pair("strafe")} to strafe` : vertical ? `, ${pair("vertical")} for up / down` : ""}. Space stops.</p>
        </div>
    )
}
