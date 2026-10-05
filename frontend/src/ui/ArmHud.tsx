// The bottom bar for an arm: the arm switch, the end-effector keys lighting up as they're held, the gripper keys, and
// what's being sent. On a phone: arm and STOP (jogging is the arm panel's hold buttons).
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { EeAxis } from "../profile/types.ts"

export function ArmHud({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const drive = useStore(app.drive.state)
    const state = useStore(app.arm.state)
    const keys = app.profile.arm?.keys ?? {}
    const armed = drive.armed
    const keyFor = (axis: EeAxis, sign: number) => Object.entries(keys).find(([, action]) => "ee" in action && action.ee === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const cell = (axis: EeAxis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${Math.sign(state.ee[axis]) === sign && state.ee[axis] !== 0 ? "down" : ""}`} title={`${axis} ${sign > 0 ? "+" : "−"}`}>{key}</span> : <span className="key empty" />
    }
    const armButton = (
        <button type="button" className={`dim-btn lg arm-button ${armed ? "danger armed" : ""}`} onClick={() => app.drive.setArmed(!armed)} title={armed ? "Disarm: stop sending commands" : "Arm: jogging moves the arm"}>
            {armed ? "ARMED" : "ARM"}
        </button>
    )
    const activity = state.jogging
        ? `jog ${state.jogging.joint.replace(/^.*\//, "")} ${state.jogging.sign > 0 ? "+" : "−"}`
        : Object.entries(state.ee).filter(([, value]) => value).map(([axis, value]) => `${axis}${value > 0 ? "+" : "−"}`).join(" ")
    if (mobile) {
        return (
            <div className={`drive-hud mobile arm-hud ${armed ? "armed" : ""}`}>
                <div className="hud-center">
                    {armButton}
                    {armed && <button type="button" className="dim-btn danger lg stop-button" onClick={() => app.arm.stop()}>STOP</button>}
                </div>
            </div>
        )
    }
    return (
        <div className={`dim-panel glass drive-hud arm-hud ${armed ? "armed" : ""}`} data-testid="arm-hud">
            {armButton}
            {state.topics.eeTwist && (
                <div className="keys" aria-label="end-effector keys">
                    <div>{cell("z", 1)}{cell("x", 1)}{cell("z", -1)}{cell("roll", 1)}{cell("pitch", 1)}{cell("yaw", 1)}</div>
                    <div>{cell("y", 1)}{cell("x", -1)}{cell("y", -1)}{cell("roll", -1)}{cell("pitch", -1)}{cell("yaw", -1)}</div>
                </div>
            )}
            {state.topics.grippers.length > 0 && (
                <div className="keys" aria-label="gripper keys">
                    <div><span className="key" title="open the gripper">[</span></div>
                    <div><span className="key" title="close the gripper">]</span></div>
                </div>
            )}
            <div className="hud-readout" data-testid="arm-hud-readout">
                {armed
                    ? <>{activity || "armed · hold a key or a jog button"}<br /><span className="dim" title={[state.topics.eeTwist, state.topics.jointCommand, ...state.topics.grippers].filter(Boolean).join(", ")}>{state.topics.jointCommand || state.topics.eeTwist || state.topics.grippers.length ? `sent ${state.sent}` : "no arm inputs running"}</span></>
                    : <span className="dim">disarmed · nothing is sent</span>}
            </div>
        </div>
    )
}
