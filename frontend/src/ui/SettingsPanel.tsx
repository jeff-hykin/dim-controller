// View settings and the robot profile.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { Field, Toggle } from "./controls.tsx"
import { Icon } from "./icons.tsx"

export function SettingsPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    return (
        <div className="settings-panel">
            <Field label="Robot" hint="key bindings, drive topics, speeds and extra controls (src/profile)">
                <select
                    value={app.profile.name}
                    onChange={(event) => {
                        app.settings.update({ profile: event.target.value })
                        location.reload()
                    }}
                >
                    {profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
                </select>
            </Field>
            <Field label="Theme">
                <span className="segmented">
                    {(["dark", "light", "system"] as const).map((theme) => (
                        <button type="button" key={theme} className={(view.theme ?? "dark") === theme ? "on" : ""} onClick={() => app.settings.update({ theme })}>{theme}</button>
                    ))}
                </span>
            </Field>
            <Field label="Follow robot"><Toggle value={view.follow} onChange={(follow) => app.settings.update({ follow })} /></Field>
            <Field label="Stats"><Toggle value={view.showStats} onChange={(showStats) => app.settings.update({ showStats })} /></Field>
            <div className="button-row">
                <button type="button" className="button" onClick={() => app.recenter(false)}><Icon name="target" size={16} /> Recenter</button>
                <button type="button" className="button" onClick={() => app.recenter(true)}><Icon name="top" size={16} /> Top-down</button>
            </div>
            <p className="hint">Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom.</p>
        </div>
    )
}
