// Drive settings: which Twist topics (auto or a list), speeds, a profile's joint control, and its extra controls.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Button, Checkbox, Field, Heading, Kbd, TextArea } from "dimos-react"
import { useEffect, useState } from "react"
import { JointSection } from "./JointControl.tsx"

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
            <Field
                inline={!settings.topics?.length}
                className={settings.topics?.length ? "drive-topics-field editing" : "drive-topics-field"}
                label="Topics"
                title="Auto: each running blueprint's cmd_vel entry point (one per module that takes velocity commands, never a mux's own output), else /cmd_vel and /tele_cmd_vel. One topic per line; add TwistStamped after a name for a stamped one."
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
            <Field inline label="Linear"><SpeedStepper label="Linear speed" max={3} unit="m/s" value={settings.linear} onChange={(linear) => drive.settings.update({ linear })} /></Field>
            <Field inline label="Angular"><SpeedStepper label="Angular speed" max={3} unit="rad/s" value={settings.angular} onChange={(angular) => drive.settings.update({ angular })} /></Field>
            {usesVertical && <Field inline label="Vertical"><SpeedStepper label="Vertical speed" max={2} unit="m/s" value={settings.vertical} onChange={(vertical) => drive.settings.update({ vertical })} /></Field>}
            <p className="hint">
                Shift: ×{app.profile.drive.boost.linear} linear, ×{app.profile.drive.boost.angular} turning · Space: stop · <Kbd>?</Kbd> lists every key
            </p>
            {app.profile.joint && <JointSection app={app} />}
            {app.profile.controls.length > 0 && (
                <section className="controls">
                    <Heading level={3}>{app.profile.name}</Heading>
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
