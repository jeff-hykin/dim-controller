// Drive settings: driving and turning speed, the max latency and the keyboard shortcuts, then folded away (Advanced): the output topic
// (auto or a list) and up / down speed, and a profile's extra controls. A joint is jogged from the 3D view's joint control.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Field, Kbd, NumberInput, Segmented, TextArea } from "dimos-react"
import { maxLatencyOf } from "../core/linkWatch.ts"
import { openOverlay } from "./overlay.ts"
import { useEffect, useState } from "react"
import { SettingsGroup, SettingsFold, SettingsLink } from "./SettingsGroup.tsx"

import { Stepper } from "./Stepper.tsx"

/** a drive speed: − value + in steps of 0.05, from 0.05 to `max` */
const SpeedStepper = ({ unit, ...props }: { label: string; max: number; unit: string; value: number; onChange: (value: number) => void }) => <Stepper min={0.05} step={0.05} format={(value) => `${value.toFixed(2)} ${unit}`} {...props} />

/** Settings' driving speed, also over the phone's left stick (ui/DriveHud.tsx) */
export function DrivingSpeed({ app }: { app: ViewerApp }) {
    const settings = useStore(app.drive.settings)
    return <SpeedStepper label="Driving speed" max={3} unit="m/s" value={settings.linear} onChange={(linear) => app.drive.settings.update({ linear })} />
}

/** Settings' turning speed, also over the phone's right stick */
export function TurningSpeed({ app }: { app: ViewerApp }) {
    const settings = useStore(app.drive.settings)
    return <SpeedStepper label="Turning speed" max={3} unit="rad/s" value={settings.angular} onChange={(angular) => app.drive.settings.update({ angular })} />
}

export function DrivePanel({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    return (
        <>
            <SettingsGroup title="Driving" data-section="drive">
                <Field inline className="set-row" label="Driving speed"><DrivingSpeed app={app} /></Field>
                <Field inline className="set-row" label="Turning speed"><TurningSpeed app={app} /></Field>
                <Field inline className="set-row" label="Max latency" hint="Over this latency, or when the link drops, driving stops until you press Reconnect.">
                    <MaxLatencyInput app={app} />
                </Field>
                <SettingsLink label="Keyboard shortcuts" icon="keyboard" data-testid="keyboard-shortcuts" title="Every key and gamepad control (?)" trailing={<Kbd className="lv-kbd">?</Kbd>} onClick={() => openOverlay("help")} />
            </SettingsGroup>
            {state.error && <p className="problem">{state.error}</p>}
        </>
    )
}

/** Settings' max latency (the link watch, core/linkWatch.ts); also on the disengaged banner's cog. */
export function MaxLatencyInput({ app }: { app: ViewerApp }) {
    const saved = maxLatencyOf(useStore(app.settings).maxLatencyMs)
    return (
        <NumberInput
            className="number"
            aria-label="Max latency (ms)"
            data-testid="max-latency"
            min={1}
            step={100}
            unit="ms"
            value={saved}
            onChange={(value) => app.settings.update({ maxLatencyMs: Math.round(value) })}
        />
    )
}

/** Advanced → Keyboard: where the keys send velocity (auto, or a list) and the up / down speed */
export function DriveKeyboardFold({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const state = useStore(drive.state)
    const settings = useStore(drive.settings)
    useStore(app.connection.status)
    const candidates = drive.candidates()
    const usesVertical = Object.values(app.profile.drive.keys).some((action) => "axis" in action && action.axis === "vertical")
    const auto = !(settings.topics?.length)
    const resolved = state.topic ? state.topic.split(", ") : []
    const note = auto
        ? "Auto: each running blueprint's velocity input, else /cmd_vel and /tele_cmd_vel."
        : <>One topic per line; add TwistStamped after a name for a stamped one.{candidates.length > 0 ? <> Seen: {candidates.join(", ")}.</> : null}</>
    return (
        <SettingsFold title="Keyboard" persistKey="lv.settings.advanced.keys">
            <div className="set-row set-row-stack drive-topics-field" title="Where the keys (and sticks) send velocity.">
                <div className="set-row-line">
                    <span className="dr-field-label">Output topic</span>
                    <Segmented
                        size="sm"
                        label="Output topic"
                        items={[["auto", "Auto"], ["custom", "Custom"]]}
                        value={auto ? "auto" : "custom"}
                        onChange={(mode) => drive.settings.update({ topics: mode === "auto" ? [] : drive.autoTopics().map((topic) => topic.topic) })}
                    />
                </div>
                {auto
                    ? <div className="drive-topics drive-topics-auto" data-testid="drive-topics-resolved">{resolved.length ? resolved.map((topic) => <div key={topic}>{topic}</div>) : <span className="set-dim">nothing yet</span>}</div>
                    : <TopicsEditor topics={settings.topics!} onChange={(topics) => drive.settings.update({ topics })} />}
                <div className="set-row-note">{note}</div>
            </div>
            {usesVertical && <Field inline className="set-row" label="Up / down speed"><SpeedStepper label="Up / down speed" max={2} unit="m/s" value={settings.vertical} onChange={(vertical) => drive.settings.update({ vertical })} /></Field>}
        </SettingsFold>
    )
}

/** Advanced → a profile's extra controls (sliders and buttons) */
export function DriveProfileFold({ app }: { app: ViewerApp }) {
    const drive = app.drive
    const values = useStore(drive.controlValues)
    if (app.profile.controls.length === 0) {
        return null
    }
    return (
        <SettingsFold title={`${app.profile.name} controls`} persistKey="lv.settings.advanced.profile">
            {app.profile.controls.map((control) =>
                control.kind === "slider"
                    ? (
                        <Field inline className="set-row" key={control.id} label={control.label} title={`${control.type} on ${control.topic}`}>
                            <Stepper label={control.label} min={control.min} max={control.max} step={control.step} value={values[control.id] ?? control.initial} format={(value) => `${value.toFixed(2)}${control.unit ? ` ${control.unit}` : ""}`} onChange={(value) => drive.setControl(control.id, value)} />
                        </Field>
                    )
                    : <SettingsLink key={control.id} label={control.label} onClick={() => drive.pressButton(control.id)} />
            )}
        </SettingsFold>
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
            rows={Math.max(3, topics.length + 1)}
            value={text}
            onChange={setText}
            onBlur={() => onChange(text.split("\n").map((line) => line.trim()).filter(Boolean))}
        />
    )
}
