// Connection state, live numbers, and the panel tabs.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { recorder } from "../core/recorder.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { Icon } from "./icons.tsx"
import type { Tab } from "./SidePanel.tsx"

const TABS: { tab: Tab; icon: string; label: string }[] = [
    { tab: "layers", icon: "layers", label: "Layers" },
    { tab: "drive", icon: "drive", label: "Drive" },
    { tab: "record", icon: "record", label: "Record" },
    { tab: "tf", icon: "tree", label: "TF" },
    { tab: "settings", icon: "settings", label: "Settings" },
]

export function TopBar({ app, tab, onTab }: { app: ViewerApp; tab: Tab | null; onTab: (tab: Tab) => void }) {
    const connection = useStore(app.connection.status)
    const stats = useStore(app.viewer.stats)
    const tf = useStore(app.tf.summary)
    const recording = useStore(recorder.status).recording.active
    const drive = useStore(app.drive.state)
    const fallback = useStore(splatFallback)
    const live = connection.state === "connected"
    return (
        <header className="topbar">
            <img className="brand" src="./icon.svg" alt="" />
            <span className="title">Live Viewer</span>
            <span className={`pill ${live ? "on" : connection.state === "degraded" ? "warn" : ""}`} title={connection.error ?? ""}>
                <span className="dot" />
                {live ? `${connection.topics.length} topics` : connection.state === "lost" ? "no bridge" : connection.state}
                {connection.droppedPerSecond > 0 && <span className="pill-extra">{connection.droppedPerSecond} drop/s</span>}
            </span>
            <span className="pill stats-pill" title="frames per second · bridge → screen latency (p50)">
                {stats.fps} fps{stats.latencyP50 !== null ? ` · ${Math.round(stats.latencyP50)} ms` : ""}
            </span>
            {fallback.active && (
                <button type="button" className="pill warn-pill" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                    splats → cubes ({fallback.frameMs.toFixed(0)} ms)
                </button>
            )}
            {drive.armed && <span className="pill armed-pill">ARMED</span>}
            <span className="spacer" />
            <nav className="tabs">
                {TABS.map((item) => (
                    <button type="button" key={item.tab} className={`tab ${tab === item.tab ? "active" : ""}`} title={item.label} aria-label={item.label} onClick={() => onTab(item.tab)}>
                        <Icon name={item.icon} />
                        <span className="tab-label">{item.label}</span>
                        {item.tab === "record" && recording && <span className="badge rec" />}
                        {item.tab === "tf" && tf.problems > 0 && <span className="badge warn">{tf.problems}</span>}
                    </button>
                ))}
                <button
                    type="button"
                    className="tab fullscreen-tab"
                    title="Fullscreen"
                    aria-label="Fullscreen"
                    onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}
                >
                    <Icon name="fullscreen" />
                </button>
            </nav>
        </header>
    )
}
