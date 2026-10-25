// The 3D view menu's layers past its point clouds (ui/ScenePanel.tsx): every other drawable topic, grouped by layer
// type: a switch (on = subscribed), live info or the problem, and the layer's own settings behind a disclosure.
import { type ReactNode, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { useStore } from "../core/store.ts"
import { Toggle } from "dimos-react"
import { Icon } from "./icons.tsx"
import { bandwidthOverrides, setOverride } from "../core/bandwidth.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"

/** layer group label → collapsed; per viewer */
const COLLAPSED_KEY = "lv.layers.collapsed"

/** One switchable row: a toggle, the name (and type), what's below it (status), and settings behind a disclosure. */
export function Row({ value, onChange, name, type, title, className = "", testKey, below, extra, children }: {
    value: boolean
    onChange: (on: boolean) => void
    name: string
    type?: string
    title?: string
    className?: string
    testKey?: string
    below?: ReactNode
    /** controls on the row itself, after its name */
    extra?: ReactNode
    children?: ReactNode
}) {
    const [open, setOpen] = useState(false)
    return (
        <div className={`layer-row ${value ? "on" : ""} ${className}`} data-key={testKey}>
            <div className="layer-line">
                <Toggle aria-label={name} value={value} onChange={onChange} />
                <button type="button" className="layer-name" onClick={() => setOpen(!open)} disabled={!children} title={title}>
                    <span className="topic-name">{name}</span>
                    {type && <span className="topic-type">{type}</span>}
                    {children && <span className={`chevron ${open ? "open" : ""}`}><Icon name="chevron-right" size={14} /></span>}
                </button>
                {extra}
            </div>
            {below}
            {open && children && <div className="layer-settings">{children}</div>}
        </div>
    )
}

/** A layer's live info or problem under its row, or that it's paused in Network → Bandwidth Consumers (on, but nothing subscribed). */
export function LayerStatusLine({ entry }: { entry: LayerEntry }) {
    const paused = !!useStore(bandwidthOverrides)[entry.topic.key]?.paused
    if (!entry.enabled) {
        return null
    }
    if (paused) {
        return (
            <div className="layer-status paused" data-testid="layer-paused">
                paused in Network · <button type="button" className="net-link" onClick={() => setOverride(entry.topic.key, { paused: undefined })}>resume</button>
            </div>
        )
    }
    const text = entry.status.problem ?? entry.status.info
    return text ? <div className={`layer-status ${entry.status.problem ? "problem" : ""}`}>{text}</div> : null
}

function LayerRow({ app, entry }: { app: ViewerApp; entry: LayerEntry }) {
    const Settings = entry.type.Settings
    const RowControls = entry.type.RowControls
    return (
        <Row
            value={entry.enabled}
            onChange={(enabled) => app.layers.setEnabled(entry.topic.key, enabled)}
            name={entry.topic.name}
            type={entry.topic.type.split(".")[1]}
            title={entry.topic.key}
            className={entry.status.problem ? "problem" : ""}
            testKey={entry.topic.key}
            below={<LayerStatusLine entry={entry} />}
            extra={RowControls && <RowControls settings={entry.settings} topic={entry.topic} />}
        >
            {Settings && <Settings settings={entry.settings} topic={entry.topic} />}
        </Row>
    )
}

/** @param heads controls at the top of a group, by its label (the group shows even with no layers in it) */
export function LayerList({ app, skip, heads = {} }: { app: ViewerApp; skip: (entry: LayerEntry) => boolean; heads?: Record<string, ReactNode> }) {
    const all = useStore(app.layers.entries).list
    const list = all.filter((entry) => !skip(entry))
    const connection = useStore(app.connection.status)
    const groups = new Map<string, LayerEntry[]>(Object.keys(heads).map((label) => [label, []]))
    for (const entry of list) {
        groups.set(entry.type.label, [...(groups.get(entry.type.label) ?? []), entry])
    }
    const [collapsed, setCollapsed] = useState(() => readLocal<Record<string, boolean>>(COLLAPSED_KEY, {}))
    const toggle = (label: string) => {
        const next = { ...collapsed, [label]: !collapsed[label] }
        setCollapsed(next)
        writeLocal(COLLAPSED_KEY, next)
    }
    const drawn = new Set(all.map((entry) => entry.topic.key))
    const other = connection.topics.filter((topic) => !drawn.has(topic.key))
    return (
        <div className="layers">
            {[...groups].map(([label, entries]) => (
                <section key={label} className={`layer-group ${collapsed[label] ? "collapsed" : ""}`}>
                    <button type="button" className="quality-title layer-group-title" aria-expanded={!collapsed[label]} onClick={() => toggle(label)}>
                        <span className={`chevron ${collapsed[label] ? "" : "open"}`}><Icon name="chevron-right" size={12} /></span>
                        {label}
                        {collapsed[label] && <span className="layer-group-count">{entries.length}</span>}
                    </button>
                    {!collapsed[label] && heads[label]}
                    {!collapsed[label] && entries.map((entry) => {
                        const Rows = entry.type.Rows
                        return Rows ? <Rows key={entry.topic.key} entry={entry} layers={app.layers} /> : <LayerRow key={entry.topic.key} app={app} entry={entry} />
                    })}
                </section>
            ))}
            {other.length > 0 && (
                <details className="layer-group other-topics">
                    <summary>{other.length} other topics (not drawn)</summary>
                    {other.map((topic) => <div key={topic.key} className="other-topic"><span>{topic.name}</span><span className="topic-type">{topic.type}</span></div>)}
                </details>
            )}
        </div>
    )
}
