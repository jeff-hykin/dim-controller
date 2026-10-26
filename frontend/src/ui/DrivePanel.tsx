// Drive settings: the keyboard shortcuts, driving and turning speed, then folded away: the output topic (auto or a
// list) and up / down speed, and a profile's extra controls. A joint is jogged from the 3D view's joint control.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Button, Checkbox, Disclosure, Field, Kbd, TextArea } from "dimos-react"
import { Icon } from "./icons.tsx"
import { openOverlay } from "./overlay.ts"
import { useEffect, useState } from "react"

import { Stepper } from "./Stepper.tsx"

/** a drive speed: − value + in steps of 0.05, from 0.05 to `max` */
const SpeedStepper = ({ unit, ...props }: { label: string; max: number; unit: string; value: number; onChange: (value: number) => void }) => <Stepper min={0.05} step={0.05} format={(value) => `${value.toFixed(2)} ${unit}`} {...props} />

export function DrivePanel({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    const values = useStore(drive.controlValues)
    useStore(app.connection.status)
    const candidates = drive.candidates()
    const usesVertical = Object.values(app.profile.drive.keys).some((action) => "axis" in action && action.axis === "vertical")
    return (
        <div className="drive-panel">
            <Button className="keyboard-shortcuts-button" data-testid="keyboard-shortcuts" title="Every key and gamepad control (?)" onClick={() => openOverlay("help")}>
                <Icon name="keyboard" size={15} />Keyboard shortcuts<Kbd className="lv-kbd">?</Kbd>
            </Button>
            <Field inline label="Driving speed"><SpeedStepper label="Driving speed" max={3} unit="m/s" value={settings.linear} onChange={(linear) => drive.settings.update({ linear })} /></Field>
            <Field inline label="Turning speed"><SpeedStepper label="Turning speed" max={3} unit="rad/s" value={settings.angular} onChange={(angular) => drive.settings.update({ angular })} /></Field>
            <p className="hint">Hold Shift to go fast (×{app.profile.drive.boost.linear} driving, ×{app.profile.drive.boost.angular} turning) · Space stops.</p>
            <Disclosure title="Advanced keyboard controls" defaultOpen={false} persistKey="lv.settings.advanced.keys">
                <Field
                    inline={!settings.topics?.length}
                    className={settings.topics?.length ? "drive-topics-field editing" : "drive-topics-field"}
                    label="Output topic"
                    title="Where the keys (and sticks) send velocity. Auto: each running blueprint's cmd_vel entry point (one per module that takes velocity commands, never a mux's own output), else /cmd_vel and /tele_cmd_vel. One topic per line; add TwistStamped after a name for a stamped one."
                >
                    <Checkbox
                        label="auto"
                        value={!(settings.topics?.length)}
                        onChange={(auto) => drive.settings.update({ topics: auto ? [] : drive.autoTopics().map((topic) => topic.topic) })}
                    />
                    {settings.topics?.length ? <TopicsEditor topics={settings.topics} onChange={(topics) => drive.settings.update({ topics })} /> : null}
                    <div className="hint" data-testid="drive-topics-resolved">→ {state.topic || "nothing"}</div>
                </Field>
                {candidates.length > 0 && settings.topics?.length
                    ? <p className="hint">Seen: {candidates.join(", ")}</p>
                    : null}
                {usesVertical && <Field inline label="Up / down speed"><SpeedStepper label="Up / down speed" max={2} unit="m/s" value={settings.vertical} onChange={(vertical) => drive.settings.update({ vertical })} /></Field>}
            </Disclosure>
            {app.profile.controls.length > 0 && (
                <Disclosure title={`Advanced ${app.profile.name} controls`} defaultOpen={false} persistKey="lv.settings.advanced.profile">
                    <section className="controls">
                        {app.profile.controls.map((control) =>
                            control.kind === "slider"
                                ? (
                                    <Field inline key={control.id} label={control.label} title={`${control.type} on ${control.topic}`}>
                                        <Stepper label={control.label} min={control.min} max={control.max} step={control.step} value={values[control.id] ?? control.initial} format={(value) => `${value.toFixed(2)}${control.unit ? ` ${control.unit}` : ""}`} onChange={(value) => drive.setControl(control.id, value)} />
                                    </Field>
                                )
                                : <Button key={control.id} size="sm" onClick={() => drive.pressButton(control.id)}>{control.label}</Button>
                        )}
                    </section>
                </Disclosure>
            )}
            {state.error && <p className="problem">{state.error}</p>}
        </div>
    )
}

/** The drive topics, one per line: saved when the box loses focus (typing a name never drives half of it). */
function TopicsEditor({ topics, onChange }: { topics: string[]; onChange: (topics: string[]) => void }) {
    const saved = topics.join("\n")
    const [text, setText] = useState(saved)
    useEffect(() => setText(saved), [saved])
    return (
        <TextArea
            data-testid="drive-topics"
            className="drive-topics"
            mono
            rows={Math.max(2, topics.length + 1)}
            value={text}
            onChange={setText}
            onBlur={() => onChange(text.split("\n").map((line) => line.trim()).filter(Boolean))}
        />
    )
}
