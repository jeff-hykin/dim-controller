// The viewer's render numbers, shown inside the Network panel (not floating over the main view): fps, CPU per frame,
// bridge→screen latency, arrival→frame, the control round trip, and what three.js drew.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"

export function RenderStats({ app }: { app: ViewerApp }) {
    const stats = useStore(app.viewer.stats)
    const connection = useStore(app.connection.status)
    const ms = (value: number | null) => value === null ? "–" : `${value.toFixed(1)} ms`
    return (
        <div className="net-render dr-mono" data-testid="render-stats">
            <div>{stats.fps} fps · {stats.frameMs.toFixed(2)} ms/frame CPU</div>
            <div>latency p50 {ms(stats.latencyP50)} · p95 {ms(stats.latencyP95)}</div>
            <div>arrival→frame {ms(stats.arrivalToFrameMs)} · rtt {ms(connection.rttMs)}</div>
            <div>{stats.points.toLocaleString()} points · {stats.drawCalls} draws</div>
        </div>
    )
}
