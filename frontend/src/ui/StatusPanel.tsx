// The Status panel: the link, the robot, driving and rendering at a glance, in more detail than the status strip.
// Read-only.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { profiles } from "../profile/index.ts"
import { RobotIcon } from "./RobotIcon.tsx"

export function StatusPanel({ app }: { app: ViewerApp }) {
    const connection = useStore(app.connection.status)
    const stats = useStore(app.viewer.stats)
    const robot = useStore(app.robot)
    const drive = useStore(app.drive.state)
    const { issues } = useStore(app.tfIssues)
    const ms = (value: number | null) => value === null ? "–" : `${Math.round(value)} ms`
    const live = connection.state === "connected"
    const driving = drive.halt
        ? { text: drive.halt.reason === "lost" ? "held: link lost" : `held: latency over ${drive.halt.maxMs} ms`, tone: "bad" }
        : drive.publishing
        ? { text: `sending · ${drive.sent}`, tone: "ok" }
        : { text: "idle", tone: "" }
    const rows: [string, string, string][] = [
        ["Link", live ? `${connection.topics.length} topics` : connection.state === "lost" ? "no gateway" : connection.state, live ? "ok" : "warn"],
        ["Round trip", ms(connection.rttMs), ""],
        ["Dropped", `${connection.droppedPerSecond}/s`, connection.droppedPerSecond > 0 ? "warn" : ""],
        ["Drive", driving.text, driving.tone],
        ["Drive topic", drive.topic || "nothing", drive.topic ? "" : "warn"],
        ["Render", `${stats.fps} fps · ${stats.points.toLocaleString()} pts`, ""],
        ["Latency", `p50 ${ms(stats.latencyP50)} · p95 ${ms(stats.latencyP95)}`, ""],
        ["TF", issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues[0].summary}` : "ok", issues.length ? "warn" : "ok"],
    ]
    return (
        <div className="status-panel" data-testid="status-panel">
            <div className="status-robot">
                <RobotIcon type={robot.type} size={32} />
                <span>{profiles.find((profile) => profile.type === robot.type)?.name ?? robot.type}{robot.auto ? " (auto)" : ""}</span>
            </div>
            <dl className="status-rows">
                {rows.map(([label, value, tone]) => (
                    <div key={label} className="status-row">
                        <dt>{label}</dt>
                        <dd className={tone ? `tone-${tone}` : ""} title={value}>{value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    )
}
