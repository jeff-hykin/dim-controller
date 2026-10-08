// The status strip across the top: is the link up and how slow is it, what's running, what the drive is doing (ready,
// driving, the agent driving, held), the TF and render warnings; then Record, the palette and the shortcut list. On a
// phone it also opens the two drawers (the rails). In Desktop's shell its window title already shows the icon and
// name, so the strip leaves them out.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { profiles } from "../profile/index.ts"
import { Icon } from "./icons.tsx"
import { inDesktopShell } from "../dim-app/source/desktop.js"
import { RecordControl } from "./RecordControl.tsx"
import { openOverlay } from "./overlay.ts"
import type { WorkspaceApi } from "./Workspace.tsx"
import { gamepadStatus } from "./useGamepad.ts"

type Tone = "ok" | "warn" | "bad" | "busy" | ""

/** The drive's state in a word or two, and how it should read. */
export function driveMode(state: { halt: { reason: string; latencyMs: number | null; maxMs: number } | null; command: { dryRun: boolean; source: string } | null; publishing: boolean; topic: string }): { text: string; tone: Tone; detail: string } {
    if (state.halt) {
        return state.halt.reason === "lost"
            ? { text: "Held: link lost", tone: "bad", detail: "Driving stopped until you reconnect" }
            : { text: `Held: ${state.halt.latencyMs ?? "?"} ms`, tone: "bad", detail: `Latency over the ${state.halt.maxMs} ms max: driving stopped until you reconnect` }
    }
    if (state.command) {
        return state.command.dryRun ? { text: "Dry run", tone: "warn", detail: "The agent's command, not sent" } : { text: `${state.command.source} driving`, tone: "busy", detail: "Space stops it" }
    }
    if (state.publishing) {
        return { text: "Driving", tone: "busy", detail: `→ ${state.topic}` }
    }
    if (!state.topic) {
        return { text: "No drive topic", tone: "warn", detail: "Nothing takes cmd_vel yet: start a blueprint, or set topics in Settings" }
    }
    return { text: "Ready", tone: "ok", detail: `Keys and sticks drive → ${state.topic}` }
}

export function StatusStrip({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const connection = useStore(app.connection.status)
    const stats = useStore(app.viewer.stats)
    const runs = useStore(app.runs.state)
    const drive = useStore(app.drive.state)
    const robot = useStore(app.robot)
    const { issues: tfIssues } = useStore(app.tfIssues)
    const fallback = useStore(splatFallback)
    const live = connection.state === "connected"
    const linkTone: Tone = live ? (connection.rttMs !== null && connection.rttMs > 250 ? "warn" : "ok") : connection.state === "degraded" || connection.state === "connecting" ? "warn" : "bad"
    const linkText = live ? (connection.rttMs !== null ? `${Math.round(connection.rttMs)} ms` : "up") : connection.state === "lost" ? "no gateway" : connection.state
    const run = runs.running.length ? runs.running.join(", ") : runs.starting ? `starting ${runs.starting}…` : runs.known && runs.desktop ? "no blueprint" : "—"
    const mode = app.profile.type === "arm" ? { text: "Arm", tone: "" as Tone, detail: "Arm keys in the dock" } : driveMode(drive)
    const robotName = profiles.find((profile) => profile.type === robot.type)?.name ?? robot.type
    const { mobile } = api
    return (
        <header className="status-strip" data-testid="status-strip">
            {mobile && (
                <button type="button" className={`dim-btn icon strip-drawer ${api.view.drawer === "left" ? "on" : ""}`} aria-label="Left panels" title="Left panels ([)" aria-expanded={api.view.drawer === "left"} onClick={() => api.toggleRail("left")}>
                    <Icon name="panels" size={18} />
                </button>
            )}
            {!inDesktopShell() && !mobile && (
                <>
                    <img className="brand" src="./icon.svg" alt="" />
                    <span className="title dim-title">Controller</span>
                </>
            )}
            <span className={`strip-chip tone-${linkTone}`} title={`Link: ${connection.state}${connection.error ? ` (${connection.error})` : ""} · ${connection.topics.length} topics · round trip ${connection.rttMs ?? "?"} ms${connection.droppedPerSecond ? ` · ${connection.droppedPerSecond} dropped/s` : ""}`} data-testid="strip-link">
                <span className="strip-dot" />
                <span className="strip-key">Link</span>
                <span className="strip-value">{linkText}</span>
                {connection.droppedPerSecond > 0 && <span className="strip-extra">{connection.droppedPerSecond} drop/s</span>}
            </span>
            <span className="strip-chip strip-run" title={`Running: ${run}`} data-testid="strip-run">
                <span className="strip-key">Run</span>
                <span className="strip-value">{run}</span>
            </span>
            <span className={`strip-chip tone-${mode.tone}`} title={`${robotName}: ${mode.detail}`} data-testid="strip-mode">
                <span className="strip-dot" />
                <span className="strip-key">{mobile ? "" : robotName}</span>
                <span className="strip-value">{mode.text}</span>
            </span>
            {!mobile && (
                <span className="strip-chip strip-render" title="render frames per second · gateway → screen latency (p50)">
                    <span className="strip-value">{stats.fps} fps{stats.latencyP50 !== null ? ` · ${Math.round(stats.latencyP50)} ms` : ""}</span>
                </span>
            )}
            <GamepadChip />
            {tfIssues.length > 0 && (
                <button type="button" className="strip-chip tone-warn strip-button" title={`TF: ${tfIssues[0].summary} (open the TF panel)`} onClick={() => api.act("tf", "show")}>
                    <Icon name="warn" size={13} />
                    <span className="strip-value">TF {tfIssues.length}</span>
                </button>
            )}
            {fallback.active && !mobile && (
                <button type="button" className="strip-chip tone-warn strip-button" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                    <span className="strip-value">splats → cubes</span>
                </button>
            )}
            <span className="strip-spacer" />
            <RecordControl app={app} />
            <button type="button" className="dim-btn strip-command" title="Command palette: every action, searchable (/)" aria-label="Command palette" onClick={() => openOverlay("palette")} data-testid="open-palette">
                <Icon name="search" size={15} />
                {!mobile && <span>Commands</span>}
                {!mobile && <kbd className="lv-kbd">/</kbd>}
            </button>
            {!mobile && (
                <button type="button" className="dim-btn icon strip-help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => openOverlay("help")}>
                    <Icon name="keyboard" size={16} />
                </button>
            )}
            {mobile && (
                <button type="button" className={`dim-btn icon strip-drawer ${api.view.drawer === "right" ? "on" : ""}`} aria-label="Right panels" title="Right panels (])" aria-expanded={api.view.drawer === "right"} onClick={() => api.toggleRail("right")}>
                    <Icon name="settings" size={18} />
                </button>
            )}
        </header>
    )
}

/** A gamepad connected: its state (ready, waiting for the sticks at rest, stopped until A); nothing without one. */
function GamepadChip() {
    const pad = useStore(gamepadStatus)
    if (!pad.connected) {
        return null
    }
    const [tone, text, detail] = pad.stopped
        ? ["warn", "stopped", "LT + RT stopped it: press A to drive again"]
        : pad.ready
        ? ["ok", "ready", "the sticks drive (LT + RT: STOP)"]
        : ["warn", "center sticks", "nothing is sent until both sticks are at rest and the triggers are out"]
    return (
        <span className={`strip-chip tone-${tone} strip-gamepad`} title={`Gamepad: ${pad.id} · ${detail}`} data-testid="strip-gamepad">
            <Icon name="gamepad" size={14} />
            <span className="strip-value">{text}</span>
        </span>
    )
}
