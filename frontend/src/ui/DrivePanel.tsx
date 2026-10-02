// Drive settings: arm, which Twist topic, speeds, and the profile's extra controls.
import { useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Field, Slider, Toggle } from "./controls.tsx"

export function DrivePanel({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    const values = useStore(drive.controlValues)
    useStore(app.connection.status)
    const [custom, setCustom] = useState("")
    const candidates = drive.candidates()
    const usesVertical = Object.values(app.profile.drive.keys).some((action) => "axis" in action && action.axis === "vertical")
    const keyNames = Object.entries(app.profile.drive.keys)
        .filter(([code]) => !code.startsWith("Arrow"))
        .map(([code, action]) => `${code.replace(/^Key/, "")} ${"axis" in action ? `${action.axis} ${action.value > 0 ? "+" : "−"}` : `${action.control} ${(action.step ?? 0) > 0 ? "+" : "−"}`}`)
    return (
        <div className="drive-panel">
            <div className={`arm-row ${state.armed ? "armed" : ""}`}>
                <Toggle value={state.armed} onChange={(armed) => drive.setArmed(armed)} label={state.armed ? "Armed: keys and sticks move the robot" : "Disarmed: nothing is sent"} />
            </div>
            <Field label="Topic" hint="geometry_msgs.Twist commands go to dimos/<topic>/geometry_msgs.Twist">
                <select
                    value={settings.topic || ""}
                    onChange={(event) => drive.settings.update({ topic: event.target.value })}
                >
                    <option value="">auto ({state.topic})</option>
                    {candidates.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                    {settings.topic && !candidates.includes(settings.topic) && <option value={settings.topic}>{settings.topic}</option>}
                </select>
            </Field>
            <Field label="Other">
                <input
                    className="text"
                    placeholder="/my_cmd_vel"
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && custom.trim()) {
                            drive.settings.update({ topic: "/" + custom.trim().replace(/^\/+/, "") })
                            setCustom("")
                        }
                    }}
                />
            </Field>
            <Field label="Linear"><Slider min={0.05} max={3} step={0.05} value={settings.linear} format={(speed) => `${speed.toFixed(2)} m/s`} onChange={(linear) => drive.settings.update({ linear })} /></Field>
            <Field label="Angular"><Slider min={0.05} max={3} step={0.05} value={settings.angular} format={(speed) => `${speed.toFixed(2)} rad/s`} onChange={(angular) => drive.settings.update({ angular })} /></Field>
            {usesVertical && <Field label="Vertical"><Slider min={0.05} max={2} step={0.05} value={settings.vertical} format={(speed) => `${speed.toFixed(2)} m/s`} onChange={(vertical) => drive.settings.update({ vertical })} /></Field>}
            <p className="hint">
                Shift: ×{app.profile.drive.boost.linear} linear, ×{app.profile.drive.boost.angular} turning · Space: stop · {keyNames.join(" · ")}
            </p>
            {app.profile.controls.length > 0 && (
                <section className="controls">
                    <h3>{app.profile.name}</h3>
                    {app.profile.controls.map((control) =>
                        control.kind === "slider"
                            ? (
                                <Field key={control.id} label={control.label} hint={`${control.type} on ${control.topic}`}>
                                    <Slider min={control.min} max={control.max} step={control.step} value={values[control.id] ?? control.initial} format={(value) => `${value.toFixed(2)}${control.unit ? ` ${control.unit}` : ""}`} onChange={(value) => drive.setControl(control.id, value)} />
                                </Field>
                            )
                            : <button key={control.id} type="button" className="button" disabled={!state.armed} onClick={() => drive.pressButton(control.id)}>{control.label}</button>
                    )}
                </section>
            )}
            <div className="twist-readout">
                <span>lin {state.twist.linear.map((value) => value.toFixed(2)).join(" ")}</span>
                <span>ang {state.twist.angular.map((value) => value.toFixed(2)).join(" ")}</span>
                <span>{state.publishing ? `sending · ${state.sent}` : "idle"}</span>
            </div>
            {state.error && <p className="problem">{state.error}</p>}
        </div>
    )
}
