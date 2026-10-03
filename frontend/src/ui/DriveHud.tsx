// Driving on screen. Desktop: an arm switch and the profile's keys lighting up as they're held. Phone: arm, a left
// stick (forward/back + turn), a right stick (strafe, or up/down for profiles with a vertical axis), boost and STOP.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { Axis } from "../profile/types.ts"
import { Joystick } from "./Joystick.tsx"

export function DriveHud({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const keys = app.profile.drive.keys
    const usesVertical = Object.values(keys).some((action) => "axis" in action && action.axis === "vertical")
    const usesStrafe = Object.values(keys).some((action) => "axis" in action && action.axis === "strafe")
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const lit = (axis: Axis, sign: number) => Math.sign(state.axes[axis]) === sign && state.axes[axis] !== 0

    const arm = (
        <button type="button" className={`dim-btn lg arm-button ${state.armed ? "danger armed" : ""}`} onClick={() => drive.setArmed(!state.armed)} title={state.armed ? "Disarm: stop sending commands" : "Arm: keys and sticks drive the robot"}>
            {state.armed ? "ARMED" : "ARM"}
        </button>
    )

    if (mobile) {
        return (
            <div className={`drive-hud mobile ${state.armed ? "armed" : ""}`}>
                {state.armed && <Joystick label="drive" onMove={(x, y) => drive.setAxes("left-stick", { forward: y, turn: -x })} />}
                <div className="hud-center">
                    {arm}
                    {state.armed && (
                        <>
                            <button type="button" className={`dim-btn boost-button ${state.boost ? "on" : ""}`} aria-pressed={state.boost} onClick={() => drive.setBoost(!state.boost)}>{state.boost ? "FAST" : "fast"}</button>
                            <button type="button" className="dim-btn danger lg stop-button" onClick={() => drive.stop()}>STOP</button>
                        </>
                    )}
                </div>
                {state.armed && (usesVertical || usesStrafe) && (
                    <Joystick label={usesVertical ? "up / down" : "strafe"} onMove={(x, y) => drive.setAxes("right-stick", usesVertical ? { vertical: y, strafe: 0 } : { strafe: -x })} />
                )}
            </div>
        )
    }

    const cell = (axis: Axis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${lit(axis, sign) ? "down" : ""}`}>{key}</span> : <span className="key empty" />
    }
    return (
        <div className={`dim-panel glass drive-hud ${state.armed ? "armed" : ""}`}>
            {arm}
            <div className="keys" aria-label="drive keys">
                <div>{usesStrafe ? cell("strafe", 1) : usesVertical ? cell("vertical", -1) : <span className="key empty" />}{cell("forward", 1)}{usesStrafe ? cell("strafe", -1) : usesVertical ? cell("vertical", 1) : <span className="key empty" />}</div>
                <div>{cell("turn", 1)}{cell("forward", -1)}{cell("turn", -1)}</div>
            </div>
            <span className={`key shift ${state.boost ? "down" : ""}`}>⇧</span>
            <div className="hud-readout">
                {state.armed
                    ? <>{state.twist.linear[0].toFixed(2)} m/s · {state.twist.angular[2].toFixed(2)} rad/s<br /><span className="dim">→ {state.topic}</span></>
                    : <span className="dim">disarmed · nothing is sent</span>}
            </div>
        </div>
    )
}
