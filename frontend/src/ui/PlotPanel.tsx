// Plot panels (ui/workspace.ts ids plot:<n>; the settings drawer's Plot thumbnail adds one): numbers over time. Each
// series is a number inside a topic's messages (a std_msgs.Float32's data, an Odometry's twist.twist.linear.x; core/plot.ts
// lists them), many on one plot, each on the left or the right axis. Its tools: + series, pause, clear, CSV; its cog:
// history, smoothing, the y range and log scale, the line style, labels, reference lines and each series' color,
// label, scale / offset and rate-of-change. Hovering reads every series at that moment; a legend chip hides its series.
// Collapsed or off screen it holds no subscription (the samples so far stay). The plots are a backend setting
// (lv.plots), so the agent can see what's plotted.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import { persistentStore, useStore } from "../core/store.ts"
import { parseKey, Priority, type Topic } from "../core/transport.ts"
import { decode } from "../core/lcm/lcm.ts"
import {
    decimate,
    DEFAULT_PLOT,
    formatNumber,
    HISTORY_MAX_S,
    HISTORY_MIN_S,
    logTicks,
    nextColor,
    niceTicks,
    normalizePlots,
    type PlotConfig,
    plotCsv,
    type PlotSeries,
    plottableTopics,
    readField,
    SeriesBuffer,
    seriesLabel,
    seriesStats,
    smooth,
    transformValues,
    yRange,
} from "../core/plot.ts"
import { Button, Card, Field, NumberInput, SearchInput, Segmented, Select, TextInput, Toggle } from "dimos-react"
import { Icon } from "./icons.tsx"
import { popoverPosition } from "./panelDrag.ts"
import { Panel, useDismiss } from "./Panel.tsx"
import { useWorkspaceApi } from "./Workspace.tsx"
import { ContainCrash } from "./Unavailable.tsx"
import { isPlot, plotId } from "./workspace.ts"

/** the plots (a backend setting, so the agent can see what's plotted) */
export const plotLayout = persistentStore<{ plots: PlotConfig[] }>("lv.plots", { plots: [] })

export const plotsOf = (layout: { plots?: unknown }) => normalizePlots(layout?.plots)

export function updatePlot(id: number, patch: Partial<PlotConfig>) {
    plotLayout.update({ plots: plotsOf(plotLayout.get()).map((plot) => plot.id === id ? { ...plot, ...patch } : plot) })
}

/** A new plot (optionally already showing `keys`' first numbers); its workspace id. */
export function addPlot(series: { key: string; field: string }[] = []): string {
    const plots = plotsOf(plotLayout.get())
    const id = Math.max(0, ...plots.map((plot) => plot.id)) + 1
    const withColors: PlotSeries[] = []
    for (const one of series) {
        withColors.push({ id: crypto.randomUUID().slice(0, 8), key: one.key, field: one.field, color: nextColor(withColors) })
    }
    plotLayout.update({ plots: [...plots, { ...DEFAULT_PLOT, id, series: withColors }] })
    return plotId(id)
}

export function removePlot(panelId: string) {
    if (!isPlot(panelId)) {
        return
    }
    const id = Number(panelId.split(":")[1])
    plotLayout.update({ plots: plotsOf(plotLayout.get()).filter((plot) => plot.id !== id) })
    for (const key of [...samples.keys()]) {
        if (key.startsWith(`${id}:`)) {
            samples.delete(key)
        }
    }
}

/** every series' samples, by `<plot id>:<series id>`: kept across re-renders, collapses and moves */
const samples = new Map<string, SeriesBuffer>()
const bufferFor = (plot: number, series: string) => {
    const key = `${plot}:${series}`
    let buffer = samples.get(key)
    if (!buffer) {
        buffer = new SeriesBuffer()
        samples.set(key, buffer)
    }
    return buffer
}

export function PlotPanels({ app }: { app: ViewerApp }) {
    const plots = plotsOf(useStore(plotLayout))
    return <>{plots.map((plot) => <ContainCrash key={plot.id} what="Plot"><PlotPanel app={app} plot={plot} /></ContainCrash>)}</>
}

function PlotPanel({ app, plot }: { app: ViewerApp; plot: PlotConfig }) {
    const id = plotId(plot.id)
    const api = useWorkspaceApi()
    const slot = api.layout.slots[id]
    const off = !slot || slot.hidden || slot.collapsed
    const { topics } = useStore(app.connection.status)
    const [paused, setPaused] = useState<number | null>(null)
    const [picking, setPicking] = useState(plot.series.length === 0)
    // a state, not a ref: the picker opens on the first render of an empty plot, before a ref would be set
    const [addButton, setAddButton] = useState<HTMLElement | null>(null)
    const change = (patch: Partial<PlotConfig>) => updatePlot(plot.id, patch)

    // one subscription per topic while shown; each message feeds every series reading a number out of it
    const keys = [...new Set(plot.series.map((series) => series.key))]
    const seriesKey = plot.series.map((series) => `${series.id}=${series.key}#${series.field}`).join("|")
    useEffect(() => {
        if (off) {
            return
        }
        const handles = keys.map((key) => {
            const type = parseKey(key)?.type ?? ""
            const reading = plot.series.filter((series) => series.key === key)
            return app.connection.subscribe(key, { maxHz: plot.maxHz, priority: Priority.BACKGROUND }, (message) => {
                let value
                try {
                    value = decode(type, message.bytes)
                } catch {
                    return
                }
                const now = Date.now()
                for (const series of reading) {
                    const number = readField(value, series.field)
                    if (number !== null) {
                        const buffer = bufferFor(plot.id, series.id)
                        buffer.push(now, number)
                        buffer.dropBefore(now - HISTORY_MAX_S * 1000)
                    }
                }
            })
        })
        return () => handles.forEach((unsubscribe) => unsubscribe())
    }, [app, off, seriesKey, plot.maxHz])

    const names = useMemo(() => new Map(topics.map((topic) => [topic.key, topic.name])), [topics])
    const labelOf = (series: PlotSeries) => seriesLabel(series, names.get(series.key) ?? parseKey(series.key)?.name ?? series.key)
    const title = plot.title || (plot.series.length === 1 ? labelOf(plot.series[0]) : `Plot ${plot.id}`)
    const exportCsv = () => {
        const csv = plotCsv(plot.series.map((series) => ({ label: labelOf(series), ...bufferFor(plot.id, series.id).toArrays() })))
        const link = document.createElement("a")
        link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
        link.download = `${title.replace(/[^\w.-]+/g, "_")}.csv`
        link.click()
        setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    }
    return (
        <Panel
            id={id}
            title={title}
            icon="plot"
            testid="plot-panel"
            bodyClassName="plot-body"
            onClose={() => removePlot(id)}
            settings={() => <PlotSettings plot={plot} labelOf={labelOf} onChange={change} />}
            info={slot?.collapsed ? "collapsed · nothing subscribed" : `${plot.series.length} series`}
            tools={!off && (
                <div className="plot-tools">
                    <Button ref={setAddButton} size="sm" pressed={picking} title="Plot another number" data-testid="plot-add-series" onClick={() => setPicking(!picking)}>
                        <Icon name="plus" size={14} /><span>Series</span>
                    </Button>
                    <Button size="sm" className="dr-btn--icon" pressed={paused !== null} title={paused !== null ? "Resume: follow the newest samples" : "Pause: hold the picture (samples keep arriving)"} aria-label="Pause" onClick={() => setPaused(paused === null ? Date.now() : null)}>
                        <Icon name={paused !== null ? "play" : "pause"} size={14} />
                    </Button>
                    <Button size="sm" className="dr-btn--icon" title="Clear the samples" aria-label="Clear" onClick={() => plot.series.forEach((series) => bufferFor(plot.id, series.id).clear())}>
                        <Icon name="trash" size={14} />
                    </Button>
                    <Button size="sm" className="dr-btn--icon" title="Download the samples as CSV" aria-label="Download CSV" onClick={exportCsv}>
                        <Icon name="download" size={14} />
                    </Button>
                </div>
            )}
        >
            {plot.legend && plot.series.length > 0 && <Legend plot={plot} labelOf={labelOf} onToggle={(series) => change({ series: plot.series.map((one) => one.id === series.id ? { ...one, hidden: !one.hidden } : one) })} />}
            {plot.series.length === 0
                ? <div className="plot-empty"><p>Nothing plotted yet.</p><Button size="sm" onClick={() => setPicking(true)}><Icon name="plus" size={14} />Add a number to plot</Button></div>
                : <PlotCanvas plot={plot} paused={paused} labelOf={labelOf} off={off} />}
            {picking && !off && addButton && (
                <SeriesPicker
                    anchor={addButton}
                    topics={topics}
                    plot={plot}
                    onClose={() => setPicking(false)}
                    onAdd={(key, field) => change({ series: [...plot.series, { id: crypto.randomUUID().slice(0, 8), key, field, color: nextColor(plot.series) }] })}
                />
            )}
        </Panel>
    )
}

/** + Series: every topic with numbers in it (one-number topics first), searchable; a topic with several numbers opens to them. */
function SeriesPicker({ anchor, topics, plot, onAdd, onClose }: { anchor: Element | null; topics: Topic[]; plot: PlotConfig; onAdd: (key: string, field: string) => void; onClose: () => void }) {
    const [query, setQuery] = useState("")
    const [open, setOpen] = useState<string | null>(null)
    useDismiss(true, ".plot-picker, [data-testid=plot-add-series]", onClose)
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word))
    const found = plottableTopics(topics).filter((one) => matches(`${one.topic.name} ${one.topic.type} ${one.fields.join(" ")}`))
    const shown = (key: string, field: string) => plot.series.some((series) => series.key === key && series.field === field)
    return createPortal(
        <Card padded={false} className="plot-picker" role="dialog" aria-label="Plot a number" style={popoverPosition(anchor, 340)}>
            <div className="plot-picker-search"><SearchInput value={query} onChange={setQuery} placeholder="Topic or field…" autoFocus /></div>
            <div className="plot-picker-list">
                {found.length === 0 && <p className="hint plot-picker-none">{topics.length ? "No topic with numbers matches." : "No topics on the bus yet."}</p>}
                {found.map(({ topic, fields, scalar }) => {
                    const single = fields.length === 1
                    const expanded = open === topic.key || (words.length > 0 && !single && fields.some((field) => matches(field)))
                    return (
                        <div key={topic.key} className="plot-picker-topic">
                            <button
                                type="button"
                                className={`plot-picker-row ${single && shown(topic.key, fields[0]) ? "on" : ""}`}
                                onClick={() => single ? onAdd(topic.key, fields[0]) : setOpen(open === topic.key ? null : topic.key)}
                            >
                                <span className="plot-picker-name">{topic.name}</span>
                                <span className="plot-picker-type">{scalar ? topic.type.replace("std_msgs.", "") : `${topic.type.split(".").pop()} · ${fields.length}`}</span>
                                {!single && <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />}
                            </button>
                            {!single && expanded && (
                                <div className="plot-picker-fields">
                                    {fields.filter((field) => !words.length || matches(`${topic.name} ${field}`) || matches(topic.name)).map((field) => (
                                        <button type="button" key={field} className={`plot-picker-field ${shown(topic.key, field) ? "on" : ""}`} onClick={() => onAdd(topic.key, field)}>{field}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </Card>,
        document.body,
    )
}

function Legend({ plot, labelOf, onToggle }: { plot: PlotConfig; labelOf: (series: PlotSeries) => string; onToggle: (series: PlotSeries) => void }) {
    // the readings redraw a few times a second, not on every message
    const [, setTick] = useState(0)
    useEffect(() => {
        const timer = setInterval(() => setTick((tick) => tick + 1), 250)
        return () => clearInterval(timer)
    }, [])
    const now = Date.now()
    return (
        <div className="plot-legend">
            {plot.series.map((series) => {
                const { times, values } = bufferFor(plot.id, series.id).toArrays()
                const shown = transformValues(times, values, series)
                const recent = (() => {
                    let first = 0
                    while (first < times.length && times[first] < now - plot.historyS * 1000) {
                        first++
                    }
                    return shown.subarray(first)
                })()
                const stats = seriesStats(recent)
                return (
                    <button type="button" key={series.id} className={`plot-legend-item ${series.hidden ? "off" : ""}`} title={series.hidden ? "Show this series" : "Hide this series"} onClick={() => onToggle(series)}>
                        <span className="plot-swatch" style={{ background: series.color }} />
                        <span className="plot-legend-label">{labelOf(series)}{series.right ? " (right)" : ""}</span>
                        <span className="plot-legend-value">{stats ? formatNumber(stats.last) : "–"}</span>
                        {plot.stats && stats && <span className="plot-legend-stats">min {formatNumber(stats.min)} · max {formatNumber(stats.max)} · mean {formatNumber(stats.mean)}</span>}
                    </button>
                )
            })}
        </div>
    )
}

interface Theme {
    fg: string
    muted: string
    grid: string
    bg: string
    font: string
}

function readTheme(element: Element): Theme {
    const style = getComputedStyle(element)
    const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    return { fg: css("--fg", "#ddd"), muted: css("--muted-fg", "#999"), grid: css("--border", "#444"), bg: css("--card", "#111"), font: css("--mono", "monospace") }
}

const MARGIN = { top: 8, right: 10, bottom: 22 }
const AXIS_WIDTH = 46

/** The plot itself: a canvas redrawn every frame while it's live (paused: on a hover or a resize), with the hover readout. */
function PlotCanvas({ plot, paused, labelOf, off }: { plot: PlotConfig; paused: number | null; labelOf: (series: PlotSeries) => string; off: boolean }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const hover = useRef<{ x: number; y: number } | null>(null)
    const [readout, setReadout] = useState<{ x: number; y: number; time: number; rows: { label: string; color: string; value: number }[] } | null>(null)
    const config = useRef({ plot, paused, labelOf })
    config.current = { plot, paused, labelOf }
    useEffect(() => {
        const element = canvas.current
        if (!element || off) {
            return
        }
        let frame = 0
        let theme = readTheme(element)
        const retheme = () => (theme = readTheme(element))
        addEventListener("dimos-react-theme", retheme)
        const draw = () => {
            frame = requestAnimationFrame(draw)
            const { plot, paused, labelOf } = config.current
            const box = element.getBoundingClientRect()
            if (!box.width || !box.height) {
                return
            }
            const dpr = devicePixelRatio || 1
            if (element.width !== Math.round(box.width * dpr) || element.height !== Math.round(box.height * dpr)) {
                element.width = Math.round(box.width * dpr)
                element.height = Math.round(box.height * dpr)
            }
            const context = element.getContext("2d")!
            context.setTransform(dpr, 0, 0, dpr, 0, 0)
            const reading = drawPlot(context, box.width, box.height, plot, paused ?? Date.now(), theme, hover.current, labelOf)
            setReadout((before) => sameReadout(before, reading) ? before : reading)
        }
        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
            removeEventListener("dimos-react-theme", retheme)
        }
    }, [off])
    return (
        <div className="plot-canvas-wrap">
            <canvas
                ref={canvas}
                className="plot-canvas"
                data-testid="plot-canvas"
                onPointerMove={(event) => {
                    const box = event.currentTarget.getBoundingClientRect()
                    hover.current = { x: event.clientX - box.left, y: event.clientY - box.top }
                }}
                onPointerLeave={() => (hover.current = null)}
            />
            {readout && (
                <div className="plot-readout" style={{ left: readout.x, top: readout.y }}>
                    <div className="plot-readout-time">{plot.clock ? clockText(readout.time) : `${formatNumber((readout.time - (paused ?? Date.now())) / 1000, 0.1)} s`}</div>
                    {readout.rows.map((row) => (
                        <div key={row.label} className="plot-readout-row"><span className="plot-swatch" style={{ background: row.color }} />{row.label}<b>{formatNumber(row.value)}</b></div>
                    ))}
                </div>
            )}
        </div>
    )
}

type Readout = { x: number; y: number; time: number; rows: { label: string; color: string; value: number }[] } | null
const sameReadout = (a: Readout, b: Readout) =>
    a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.rows.length === b.rows.length && a.rows.every((row, index) => row.value === b.rows[index].value && row.label === b.rows[index].label))

const clockText = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/** Draws one frame of `plot` ending at `now`; the hover readout for the pointer, if it's over the plot. */
function drawPlot(context: CanvasRenderingContext2D, width: number, height: number, plot: PlotConfig, now: number, theme: Theme, pointer: { x: number; y: number } | null, labelOf: (series: PlotSeries) => string): Readout {
    context.clearRect(0, 0, width, height)
    const t1 = now, t0 = now - plot.historyS * 1000
    const visible = plot.series.filter((series) => !series.hidden)
    const hasRight = visible.some((series) => series.right)
    const left = AXIS_WIDTH + (plot.yLabel ? 14 : 0)
    const right = MARGIN.right + (hasRight ? AXIS_WIDTH + (plot.y2Label ? 14 : 0) : 0)
    const bottom = MARGIN.bottom + (plot.xLabel ? 14 : 0)
    const area = { x: left, y: MARGIN.top, width: Math.max(10, width - left - right), height: Math.max(10, height - MARGIN.top - bottom) }

    // each series' points in view, transformed and smoothed
    const drawn = visible.map((series) => {
        const { times, values } = bufferFor(plot.id, series.id).toArrays()
        const raw = transformValues(times, values, series)
        const smoothed = smooth(times, raw, plot.smoothing, plot.smoothingS)
        return {
            series,
            times,
            raw,
            smoothed,
            line: decimate(times, smoothed, t0, t1, area.width),
            rawLine: plot.smoothing !== "none" && plot.showRaw ? decimate(times, raw, t0, t1, area.width) : null,
        }
    })
    const rangeOf = (side: "left" | "right") => {
        let min = Infinity, max = -Infinity
        for (const one of drawn) {
            if (!!one.series.right !== (side === "right")) {
                continue
            }
            for (const [index, time] of one.line.times.entries()) {
                const value = one.line.values[index]
                if (time >= t0 && time <= t1 && Number.isFinite(value) && (!plot.logY || value > 0)) {
                    min = Math.min(min, value)
                    max = Math.max(max, value)
                }
            }
        }
        if (side === "left") {
            for (const mark of plot.marks) {
                min = Math.min(min, mark)
                max = Math.max(max, mark)
            }
        }
        // the fixed ends are the left axis's; the right one always fits its own series
        return yRange(min, max, side === "left" ? plot : { yMin: null, yMax: null, logY: plot.logY })
    }
    const ranges = { left: rangeOf("left"), right: rangeOf("right") }
    const toY = (value: number, side: "left" | "right") => {
        const [low, high] = ranges[side]
        const fraction = plot.logY ? (Math.log10(Math.max(value, low * 1e-6)) - Math.log10(low)) / (Math.log10(high) - Math.log10(low)) : (value - low) / (high - low)
        return area.y + area.height - fraction * area.height
    }
    const toX = (time: number) => area.x + ((time - t0) / (t1 - t0)) * area.width

    context.font = `10px ${theme.font}`
    context.lineWidth = 1
    // y ticks and grid, left then right
    const ticksFor = (side: "left" | "right") => plot.logY ? logTicks(...ranges[side]) : niceTicks(...ranges[side], Math.max(2, Math.round(area.height / 40)))
    for (const side of hasRight ? ["left", "right"] as const : ["left"] as const) {
        const ticks = ticksFor(side)
        const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1
        context.textAlign = side === "left" ? "right" : "left"
        context.textBaseline = "middle"
        for (const tick of ticks) {
            const y = Math.round(toY(tick, side)) + 0.5
            if (plot.grid && side === "left") {
                context.strokeStyle = theme.grid
                context.globalAlpha = 0.6
                context.beginPath()
                context.moveTo(area.x, y)
                context.lineTo(area.x + area.width, y)
                context.stroke()
                context.globalAlpha = 1
            }
            context.fillStyle = theme.muted
            context.fillText(formatNumber(tick, plot.logY ? tick : step), side === "left" ? area.x - 5 : area.x + area.width + 5, y)
        }
    }
    // x ticks: round seconds before now (or clock times)
    const spanS = (t1 - t0) / 1000
    const xStep = niceTicks(0, spanS, Math.max(2, Math.round(area.width / 80)))
    const stepS = xStep.length > 1 ? xStep[1] - xStep[0] : spanS
    context.textAlign = "center"
    context.textBaseline = "top"
    const firstTick = plot.clock ? Math.ceil(t0 / 1000 / stepS) * stepS * 1000 : t1 - Math.floor(spanS / stepS) * stepS * 1000
    for (let time = firstTick; time <= t1 + 1; time += stepS * 1000) {
        const x = Math.round(toX(time)) + 0.5
        if (plot.grid) {
            context.strokeStyle = theme.grid
            context.globalAlpha = 0.35
            context.beginPath()
            context.moveTo(x, area.y)
            context.lineTo(x, area.y + area.height)
            context.stroke()
            context.globalAlpha = 1
        }
        context.fillStyle = theme.muted
        context.fillText(plot.clock ? clockText(time) : `${formatNumber((time - t1) / 1000, stepS)}s`, x, area.y + area.height + 5)
    }
    // the frame
    context.strokeStyle = theme.grid
    context.strokeRect(area.x + 0.5, area.y + 0.5, area.width - 1, area.height - 1)
    // axis labels
    context.fillStyle = theme.muted
    if (plot.xLabel) {
        context.textAlign = "center"
        context.textBaseline = "bottom"
        context.fillText(plot.xLabel, area.x + area.width / 2, height - 1)
    }
    const sideways = (label: string, x: number, angle: number) => {
        context.save()
        context.translate(x, area.y + area.height / 2)
        context.rotate(angle)
        context.textAlign = "center"
        context.textBaseline = "top"
        context.fillText(label, 0, 0)
        context.restore()
    }
    if (plot.yLabel) {
        sideways(plot.yLabel, 1, -Math.PI / 2)
    }
    if (hasRight && plot.y2Label) {
        sideways(plot.y2Label, width - 1, Math.PI / 2)
    }
    // reference lines
    for (const mark of plot.marks) {
        const y = toY(mark, "left")
        if (y < area.y || y > area.y + area.height) {
            continue
        }
        context.strokeStyle = theme.fg
        context.globalAlpha = 0.5
        context.setLineDash([4, 4])
        context.beginPath()
        context.moveTo(area.x, Math.round(y) + 0.5)
        context.lineTo(area.x + area.width, Math.round(y) + 0.5)
        context.stroke()
        context.setLineDash([])
        context.globalAlpha = 1
    }

    // the series, clipped to the plot area
    context.save()
    context.beginPath()
    context.rect(area.x, area.y, area.width, area.height)
    context.clip()
    const trace = (points: { times: number[]; values: number[] }, side: "left" | "right", color: string, lineWidth: number, alpha: number, style: PlotConfig["style"]) => {
        context.strokeStyle = color
        context.fillStyle = color
        context.lineWidth = lineWidth
        context.globalAlpha = alpha
        context.lineJoin = "round"
        if (style === "points") {
            const radius = Math.max(1.5, lineWidth)
            for (const [index, time] of points.times.entries()) {
                const value = points.values[index]
                if (Number.isFinite(value)) {
                    context.beginPath()
                    context.arc(toX(time), toY(value, side), radius, 0, Math.PI * 2)
                    context.fill()
                }
            }
            context.globalAlpha = 1
            return
        }
        // a gap (NaN) breaks the line; a step holds each value until the next sample
        const runs: [number, number][][] = [[]]
        for (const [index, time] of points.times.entries()) {
            const value = points.values[index]
            if (!Number.isFinite(value) || (plot.logY && value <= 0)) {
                runs.push([])
                continue
            }
            const run = runs[runs.length - 1]
            const x = toX(time), y = toY(value, side)
            if (style === "step" && run.length) {
                run.push([x, run[run.length - 1][1]])
            }
            run.push([x, y])
        }
        for (const run of runs.filter((run) => run.length)) {
            context.beginPath()
            run.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y))
            context.stroke()
            if (style === "area") {
                const base = plot.logY ? area.y + area.height : Math.min(area.y + area.height, Math.max(area.y, toY(0, side)))
                context.lineTo(run[run.length - 1][0], base)
                context.lineTo(run[0][0], base)
                context.closePath()
                context.globalAlpha = alpha * 0.18
                context.fill()
                context.globalAlpha = alpha
            }
        }
        context.globalAlpha = 1
    }
    for (const one of drawn) {
        const side = one.series.right ? "right" : "left"
        if (one.rawLine) {
            trace(one.rawLine, side, one.series.color, 1, 0.3, plot.style === "area" ? "line" : plot.style)
        }
        trace(one.line, side, one.series.color, plot.lineWidth, 1, plot.style)
    }
    context.restore()

    // the hover: a line at that moment and each series' value there
    if (!pointer || pointer.x < area.x || pointer.x > area.x + area.width || pointer.y < area.y || pointer.y > area.y + area.height) {
        return null
    }
    const time = t0 + ((pointer.x - area.x) / area.width) * (t1 - t0)
    context.strokeStyle = theme.fg
    context.globalAlpha = 0.4
    context.beginPath()
    context.moveTo(Math.round(pointer.x) + 0.5, area.y)
    context.lineTo(Math.round(pointer.x) + 0.5, area.y + area.height)
    context.stroke()
    context.globalAlpha = 1
    const rows: { label: string; color: string; value: number }[] = []
    for (const one of drawn) {
        const at = nearest(one.times, time)
        if (at < 0 || Math.abs(one.times[at] - time) > (t1 - t0) / 20) {
            continue
        }
        const value = one.smoothed[at]
        if (!Number.isFinite(value)) {
            continue
        }
        rows.push({ label: labelOf(one.series), color: one.series.color, value })
        context.fillStyle = one.series.color
        context.beginPath()
        context.arc(toX(one.times[at]), toY(value, one.series.right ? "right" : "left"), 3.5, 0, Math.PI * 2)
        context.fill()
    }
    if (!rows.length) {
        return null
    }
    // the readout box beside the pointer, flipped to its left past the middle
    return { x: pointer.x > area.x + area.width / 2 ? Math.max(0, pointer.x - 190) : pointer.x + 12, y: Math.max(area.y, Math.min(pointer.y - 10, area.y + area.height - 30 - rows.length * 16)), time, rows }
}

/** the index of the sample nearest `time` in sorted `times` (-1: none) */
function nearest(times: Float64Array, time: number): number {
    if (!times.length) {
        return -1
    }
    let low = 0, high = times.length - 1
    while (low < high) {
        const middle = (low + high) >> 1
        if (times[middle] < time) {
            low = middle + 1
        } else {
            high = middle
        }
    }
    return low > 0 && Math.abs(times[low - 1] - time) < Math.abs(times[low] - time) ? low - 1 : low
}

/** The cog: everything about how the plot looks, then each series. */
function PlotSettings({ plot, labelOf, onChange }: { plot: PlotConfig; labelOf: (series: PlotSeries) => string; onChange: (patch: Partial<PlotConfig>) => void }) {
    const setSeries = (id: string, patch: Partial<PlotSeries>) => onChange({ series: plot.series.map((series) => series.id === id ? { ...series, ...patch } : series) })
    return (
        <div className="plot-settings" data-testid="plot-settings">
            <Field inline label="Title"><TextInput size="sm" value={plot.title} placeholder="auto" onChange={(title) => onChange({ title })} /></Field>
            <Field inline label="History" title="how many seconds across the plot">
                <NumberInput size="sm" min={HISTORY_MIN_S} max={HISTORY_MAX_S} step={5} unit="s" value={plot.historyS} onChange={(historyS) => onChange({ historyS })} />
            </Field>
            <Field inline label="Style">
                <Segmented size="sm" label="Line style" items={[["line", "Line"], ["step", "Steps"], ["points", "Points"], ["area", "Area"]]} value={plot.style} onChange={(style) => onChange({ style: style as PlotConfig["style"] })} />
            </Field>
            <Field inline label="Line width"><NumberInput size="sm" min={0.5} max={6} step={0.5} value={plot.lineWidth} onChange={(lineWidth) => onChange({ lineWidth })} /></Field>
            <Field inline label="Smoothing" title="a trailing moving average over the window, or an exponential average with that time constant">
                <Select size="sm" aria-label="Smoothing" value={plot.smoothing} options={[["none", "None"], ["average", "Moving average"], ["ema", "Exponential"]]} onChange={(smoothing) => onChange({ smoothing: smoothing as PlotConfig["smoothing"] })} />
            </Field>
            {plot.smoothing !== "none" && (
                <>
                    <Field inline label="Window"><NumberInput size="sm" min={0.01} max={600} step={0.1} unit="s" value={plot.smoothingS} onChange={(smoothingS) => onChange({ smoothingS })} /></Field>
                    <Field inline label="Raw behind" title="the unsmoothed values, faint, behind the smoothed line"><Toggle value={plot.showRaw} onChange={(showRaw: boolean) => onChange({ showRaw })} /></Field>
                </>
            )}
            <Field inline label="Y min" title="empty: fit the data">
                <NumberInput size="sm" nullable placeholder="auto" value={plot.yMin} onChange={(yMin: number | null) => onChange({ yMin })} />
            </Field>
            <Field inline label="Y max" title="empty: fit the data">
                <NumberInput size="sm" nullable placeholder="auto" value={plot.yMax} onChange={(yMax: number | null) => onChange({ yMax })} />
            </Field>
            <Field inline label="Log scale" title="a logarithmic y axis (values at or below zero aren't drawn)"><Toggle value={plot.logY} onChange={(logY: boolean) => onChange({ logY })} /></Field>
            <Field inline label="X label"><TextInput size="sm" value={plot.xLabel} placeholder="none" onChange={(xLabel) => onChange({ xLabel })} /></Field>
            <Field inline label="Y label"><TextInput size="sm" value={plot.yLabel} placeholder="none" onChange={(yLabel) => onChange({ yLabel })} /></Field>
            {plot.series.some((series) => series.right) && <Field inline label="Right label"><TextInput size="sm" value={plot.y2Label} placeholder="none" onChange={(y2Label) => onChange({ y2Label })} /></Field>}
            <Field inline label="Reference lines" title="dashed lines across the plot at these values, comma separated (a limit, a target)">
                <MarksInput marks={plot.marks} onChange={(marks) => onChange({ marks })} />
            </Field>
            <Field inline label="Clock time" title="the x axis in clock time instead of seconds before now"><Toggle value={plot.clock} onChange={(clock: boolean) => onChange({ clock })} /></Field>
            <Field inline label="Grid"><Toggle value={plot.grid} onChange={(grid: boolean) => onChange({ grid })} /></Field>
            <Field inline label="Legend"><Toggle value={plot.legend} onChange={(legend: boolean) => onChange({ legend })} /></Field>
            <Field inline label="Min / max / mean" title="each series' min, max and mean over the history, in the legend"><Toggle value={plot.stats} onChange={(stats: boolean) => onChange({ stats })} /></Field>
            <Field inline label="Max rate" title="at most this many messages a second per topic"><NumberInput size="sm" min={1} max={1000} step={10} unit="Hz" value={plot.maxHz} onChange={(maxHz) => onChange({ maxHz })} /></Field>
            {plot.series.length > 0 && <div className="plot-settings-head">Series</div>}
            {plot.series.map((series) => (
                <SeriesSettings key={series.id} series={series} label={labelOf(series)} onChange={(patch) => setSeries(series.id, patch)} onRemove={() => onChange({ series: plot.series.filter((one) => one.id !== series.id) })} />
            ))}
        </div>
    )
}

function SeriesSettings({ series, label, onChange, onRemove }: { series: PlotSeries; label: string; onChange: (patch: Partial<PlotSeries>) => void; onRemove: () => void }): ReactNode {
    return (
        <div className="plot-series-settings">
            <div className="plot-series-head">
                <input type="color" className="plot-color" value={series.color} aria-label={`${label} color`} onChange={(event) => onChange({ color: event.target.value })} />
                <TextInput size="sm" value={series.label ?? ""} placeholder={label} aria-label="Series label" onChange={(text) => onChange({ label: text || undefined })} />
                <Button size="sm" className="dr-btn--icon" title="Remove this series" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={13} /></Button>
            </div>
            <div className="plot-series-row">
                <Select size="sm" aria-label="Transform" value={series.transform ?? "none"} options={[["none", "value"], ["rate", "rate of change /s"], ["abs", "magnitude"]]} onChange={(transform) => onChange({ transform: transform === "none" ? undefined : transform as PlotSeries["transform"] })} />
                <label className="plot-inline" title="value × scale + offset">×<NumberInput size="sm" step={0.1} value={series.scale ?? 1} aria-label="Scale" onChange={(scale) => onChange({ scale })} /></label>
                <label className="plot-inline">+<NumberInput size="sm" step={0.1} value={series.offset ?? 0} aria-label="Offset" onChange={(offset) => onChange({ offset })} /></label>
                <label className="plot-inline" title="draw against the right-hand axis"><Toggle size="sm" value={!!series.right} onChange={(right: boolean) => onChange({ right: right || undefined })} />right axis</label>
            </div>
        </div>
    )
}

/** "1, 2.5, -3": saved on Enter or leaving the box */
function MarksInput({ marks, onChange }: { marks: number[]; onChange: (marks: number[]) => void }) {
    const saved = marks.join(", ")
    const [text, setText] = useState(saved)
    useEffect(() => setText(saved), [saved])
    const commit = () => onChange(text.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite).slice(0, 8))
    return <TextInput size="sm" value={text} placeholder="none" onChange={setText} onEnter={commit} onBlur={commit} />
}
