// Settings: the robot type, then driving (or the arm panel, for an arm; it was its own tab), then the view.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"
import { ArmPanel } from "./ArmPanel.tsx"
import { Field, Toggle } from "./controls.tsx"
import { DrivePanel } from "./DrivePanel.tsx"
import { rendering } from "../core/render/rendering.ts"
import { StylePicker } from "./StylePicker.tsx"
import { CUBE_SHADES, type CubeShade, type PointStyle } from "../core/render/pointMaterial.ts"

export function SettingsPanel({ app }: { app: ViewerApp }) {
    const view = useStore(app.settings)
    const render = useStore(rendering)
    const robot = useStore(app.robot)
    const current = profiles.find((profile) => profile.type === robot.type)
    return (
        <div className="settings-panel">
            <div className="field-block robot-type" data-testid="robot-type">
                <span className="field-label">Robot</span>
                <div className="robot-type-row">
                    <RobotIcon type={robot.type} size={40} />
                    <select
                        className="dim-select"
                        aria-label="Robot type"
                        value={robot.auto ? "" : robot.type}
                        // every open viewer switches with it (app.ts), no reload
                        onChange={(event) => app.settings.update({ profile: event.target.value })}
                    >
                        <option value="">Auto: {current?.name ?? robot.type}</option>
                        {profiles.map((profile) => <option key={profile.type} value={profile.type}>{profile.name}</option>)}
                    </select>
                </div>
                <p className="hint" data-testid="robot-type-reason">
                    {robot.auto ? `Auto: ${robot.reason}.` : "Picked here; Auto follows what's running."} Sets the keys, speeds, the drive or arm controls and the model in the view.
                </p>
                <p className="hint" data-testid="robot-icon-credits">
                    Icons after Izwar Muis's "Humanoid robot" and "robot dog" and rukanicon's "Robotics" (Noun Project, CC BY 3.0, modified) and Tabler's drone (MIT); see the README's Credits.
                </p>
            </div>
            {robot.type === "arm"
                ? (
                    <section className="settings-section" data-section="arm">
                        <h3 className="dim-label">Arm</h3>
                        <ArmPanel app={app} />
                    </section>
                )
                : (
                    <section className="settings-section" data-section="drive">
                        <h3 className="dim-label">Drive</h3>
                        <DrivePanel app={app} />
                    </section>
                )}
            <h3 className="dim-label">Rendering</h3>
            <div className="field-block">
                <span className="field-label">Point style</span>
                <StylePicker value={render.pointStyle} onChange={(pointStyle) => rendering.update({ pointStyle: pointStyle as PointStyle })} />
                <p className="hint">The default for every point cloud; a layer can pick its own in its settings.</p>
            </div>
            <Field label="Cube shading" hint={CUBE_SHADES[render.cubeShade]?.about}>
                <span className="dim-tabs segmented" data-cube-shade>
                    {(Object.keys(CUBE_SHADES) as CubeShade[]).map((shade) => (
                        <button type="button" key={shade} className={`dim-tab ${render.cubeShade === shade ? "on" : ""}`} aria-selected={render.cubeShade === shade} onClick={() => rendering.update({ cubeShade: shade })}>{CUBE_SHADES[shade].label}</button>
                    ))}
                </span>
            </Field>
            <Field label="Follow robot"><Toggle value={view.follow} onChange={(follow) => app.settings.update({ follow })} /></Field>
            <Field label="Robot model" hint="a stand-in for the robot type at the robot's pose (an arm is drawn by its TF frames)"><Toggle value={view.robotModel !== false} onChange={(robotModel) => app.settings.update({ robotModel })} /></Field>
            <Field label="Stats"><Toggle value={view.showStats} onChange={(showStats) => app.settings.update({ showStats })} /></Field>
            <p className="hint">Drag to orbit · right-drag or two fingers to pan · scroll or pinch to zoom. Recenter and top-down are on the view (top right).</p>
        </div>
    )
}
