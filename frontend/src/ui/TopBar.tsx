// Connection state, live numbers, and the panel tabs.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { splatFallback } from "../core/render/rendering.ts"
import { Icon } from "./icons.tsx"
import type { Tab } from "./SidePanel.tsx"

// driving's settings are Settings' first section; recording is the Record button at the top left (RecordControl)
const TABS: { tab: Tab; icon: string; label: string }[] = [
    { tab: "tf", icon: "tree", label: "TF" },
    { tab: "layers", icon: "layers", label: "Layers" },
    { tab: "settings", icon: "settings", label: "Settings" },
]

export function TopBar({ app, tab, onTab }: { app: ViewerApp; tab: Tab | null; onTab: (tab: Tab) => void }) {
    const connection = useStore(app.connection.status)
    const stats = useStore(app.viewer.stats)
    const { issues: tfIssues } = useStore(app.tfIssues)
    const fallback = useStore(splatFallback)
    const live = connection.state === "connected"
    return (
        <header className="topbar">
            <img className="brand" src="./icon.svg" alt="" />
            <span className="title dim-title">Controller</span>
            <span className={`dim-badge dim-mono conn-pill ${live ? "ok" : connection.state === "degraded" ? "warn" : ""}`} title={connection.error ?? ""}>
                <span className="dot" />
                {live ? `${connection.topics.length} topics` : connection.state === "lost" ? "no bridge" : connection.state}
                {connection.droppedPerSecond > 0 && <span className="pill-extra">{connection.droppedPerSecond} drop/s</span>}
            </span>
            <span className="dim-badge dim-mono stats-pill" title="frames per second · bridge → screen latency (p50)">
                {stats.fps} fps{stats.latencyP50 !== null ? ` · ${Math.round(stats.latencyP50)} ms` : ""}
            </span>
            {fallback.active && (
                <button type="button" className="dim-badge warn warn-pill" title={`splat frames took ${fallback.frameMs.toFixed(0)} ms (over 16 ms): drawing cubes instead. Click to try splats again.`} onClick={() => splatFallback.set({ active: false, frameMs: 0 })}>
                    splats → cubes ({fallback.frameMs.toFixed(0)} ms)
                </button>
            )}
            <span className="spacer" />
            <nav className="dim-tabs tabs">
                {TABS.map((item) => (
                    <button type="button" key={item.tab} className={`dim-tab tab ${tab === item.tab ? "active" : ""}`} aria-selected={tab === item.tab} title={item.label} aria-label={item.label} onClick={() => onTab(item.tab)}>
                        <Icon name={item.icon} />
                        <span className="tab-label">{item.label}</span>
                        {item.tab === "tf" && tfIssues.length > 0 && <span className="dim-badge warn tab-badge">{tfIssues.length}</span>}
                    </button>
                ))}
                <button
                    type="button"
                    className="dim-tab tab fullscreen-tab"
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
