// Driving on screen (no arming: keys and sticks always drive). Desktop: the profile's keys lighting up as they're held,
// in the action dock (ui/ActionDock.tsx). Phone: two thumbs, a left stick that translates (forward/back, plus strafe for profiles
// that strafe) and a right stick that turns (plus up/down for profiles with a vertical axis), STOP and boost. Both show the agent's commands (POST api/drive), dry runs included.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import type { Axis } from "../profile/types.ts"
import { Joystick, releaseAllSticks } from "./Joystick.tsx"
import type { DriveHalt } from "../core/drive.ts"

/** Driving is held (latency over the max, or the link lost): why, and the Reconnect button. */
function HaltNotice({ app, halt }: { app: ViewerApp; halt: DriveHalt }) {
    const why = halt.reason === "lost" ? "Link lost" : `Latency over ${halt.maxMs} ms${halt.latencyMs !== null ? ` (${halt.latencyMs} ms)` : ""}`
    return (
        <div className="drive-halt" role="alert" data-testid="drive-halt">
            <span>{why} · driving stopped</span>
            <button type="button" className="dim-btn reconnect-button" data-testid="reconnect-button" disabled={halt.reconnecting} onClick={() => app.reconnect()}>
                {halt.reconnecting ? "Reconnecting…" : "Reconnect"}
            </button>
        </div>
    )
}

export function DriveHud({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const keys = app.profile.drive.keys
    const usesVertical = Object.values(keys).some((action) => "axis" in action && action.axis === "vertical")
    const usesStrafe = Object.values(keys).some((action) => "axis" in action && action.axis === "strafe")
    const command = state.command
    const velocity = (linear: number[], angular: number[]) => `${linear[0].toFixed(2)}${usesStrafe ? ` / ${linear[1].toFixed(2)}` : ""}${usesVertical ? ` / ${linear[2].toFixed(2)}` : ""} m/s · ${angular[2].toFixed(2)} rad/s`

    if (mobile) {
        const moving = state.publishing && [...state.twist.linear, ...state.twist.angular].some((value) => value !== 0)
        return (
            <div className={`drive-hud mobile ${moving ? "moving" : ""}`} data-testid="drive-hud-mobile">
                <Joystick
                    side="left"
                    label={usesStrafe ? "move" : "forward / back"}
                    axes={usesStrafe ? "xy" : "y"}
                    onMove={(x, y) => drive.setAxes("left-stick", { forward: y, strafe: usesStrafe ? -x : 0 })}
                />
                <div className="hud-center">
                    {state.halt && <HaltNotice app={app} halt={state.halt} />}
                    <span className="dim-badge hud-note" data-testid="drive-readout">
                        {command ? `${command.dryRun ? "dry run" : command.source} · ${velocity(command.linear, command.angular)}` : velocity(state.twist.linear, state.twist.angular)}
                    </span>
                    <button
                        type="button"
                        className="dim-btn stop-button"
                        data-testid="stop-button"
                        onPointerDown={() => {
                            // on touch, not on the click after it: no 300 ms, and it works while a thumb holds a stick
                            releaseAllSticks()
                            drive.stop()
                        }}
                        onClick={() => {
                            releaseAllSticks()
                            drive.stop()
                        }}
                    >
                        STOP
                    </button>
                    <button type="button" className={`dim-btn boost-button ${state.boost ? "on" : ""}`} aria-pressed={state.boost} onClick={() => drive.setBoost(!state.boost)}>{state.boost ? "FAST ON" : "FAST"}</button>
                </div>
                <Joystick
                    side="right"
                    label={usesVertical ? "turn · up / down" : "turn"}
                    axes={usesVertical ? "xy" : "x"}
                    onMove={(x, y) => drive.setAxes("right-stick", { turn: -x, vertical: usesVertical ? y : 0 })}
                />
            </div>
        )
    }

    return <DriveKeys app={app} />
}

/** The desktop's drive keys (lit while held), what's being sent (or the agent's command), and the hold with Reconnect. */
export function DriveKeys({ app }: { app: ViewerApp }) {
    const state = useStore(app.drive.state)
    const keys = app.profile.drive.keys
    const usesVertical = Object.values(keys).some((action) => "axis" in action && action.axis === "vertical")
    const usesStrafe = Object.values(keys).some((action) => "axis" in action && action.axis === "strafe")
    const keyFor = (axis: Axis, sign: number) => Object.entries(keys).find(([code, action]) => !code.startsWith("Arrow") && "axis" in action && action.axis === axis && Math.sign(action.value) === sign)?.[0].replace(/^Key/, "")
    const command = state.command
    const velocity = (linear: number[], angular: number[]) => `${linear[0].toFixed(2)}${usesStrafe ? ` / ${linear[1].toFixed(2)}` : ""}${usesVertical ? ` / ${linear[2].toFixed(2)}` : ""} m/s · ${angular[2].toFixed(2)} rad/s`
    const lit = (axis: Axis, sign: number) => Math.sign(state.axes[axis]) === sign && state.axes[axis] !== 0
    const cell = (axis: Axis, sign: number) => {
        const key = keyFor(axis, sign)
        return key ? <span className={`key ${lit(axis, sign) ? "down" : ""}`}>{key}</span> : <span className="key empty" />
    }
    return (
        <div className={`dock-drive ${state.publishing ? "moving" : ""} ${state.halt ? "halted" : ""}`} data-testid="drive-hud">
            <div className="keys" aria-label="drive keys">
                <div>{usesStrafe ? cell("strafe", 1) : usesVertical ? cell("vertical", -1) : <span className="key empty" />}{cell("forward", 1)}{usesStrafe ? cell("strafe", -1) : usesVertical ? cell("vertical", 1) : <span className="key empty" />}</div>
                <div>{cell("turn", 1)}{cell("forward", -1)}{cell("turn", -1)}</div>
            </div>
            <span className={`key shift ${state.boost ? "down" : ""}`} title="Shift: boost">⇧</span>
            {state.halt
                ? <HaltNotice app={app} halt={state.halt} />
                : (
                    <div className="hud-readout" data-testid="drive-readout">
                        {command
                            ? <>{command.dryRun ? "dry run · nothing sent" : `${command.source} driving`}<br /><span className="dim">{velocity(command.linear, command.angular)} · {command.seconds} s</span></>
                            : <>{velocity(state.twist.linear, state.twist.angular)}<br /><span className="dim">→ {state.topic || "no drive topic"}</span></>}
                    </div>
                )}
        </div>
    )
}
