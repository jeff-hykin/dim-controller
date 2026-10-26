// Plot panels' data (ui/PlotPanel.tsx): which numbers a message type carries (the LCM schemas: "data", "linear.x",
// "position[2]"), reading one out of a decoded message, a series' ring of (time, value), smoothing, the per-pixel
// decimation the canvas draws, and the axes' ticks. Pure (no DOM, no React): test/plot.test.ts.
import { schemas as lcmSchemas } from "./lcm/lcm.ts"
import type { LcmValue } from "./lcm/lcm.ts"
import type { Topic } from "./transport.ts"

export interface LcmFieldDef {
    name: string
    type: string
    dims: (string | number)[]
}
type Schemas = Record<string, LcmFieldDef[]>

const NUMERIC = new Set(["boolean", "byte", "double", "float", "int8_t", "int16_t", "int32_t", "int64_t"])
/** never plotted from inside another message: a header's seq and stamp aren't the reading */
const SKIPPED = new Set(["std_msgs.Header"])
/** a variable-length number array offers its first few elements */
export const ARRAY_ELEMENTS = 8
/** a fixed array longer than this (a 36-number covariance) offers nothing */
const FIXED_ARRAY_MAX = 9
const MAX_DEPTH = 5

/** the std_msgs types that are one number: what the Plot panel's picker lists first */
export const SCALAR_TYPES = new Set([
    "std_msgs.Float32",
    "std_msgs.Float64",
    "std_msgs.Int8",
    "std_msgs.Int16",
    "std_msgs.Int32",
    "std_msgs.Int64",
    "std_msgs.UInt8",
    "std_msgs.UInt16",
    "std_msgs.UInt32",
    "std_msgs.UInt64",
    "std_msgs.Byte",
    "std_msgs.Bool",
])

/** Every number in a message of `type` as a path, in wire order ([] when it has none, or the type isn't known). */
export function numericFields(type: string, schemas: Schemas = lcmSchemas as Schemas, depth = 0): string[] {
    const fields = schemas[type]
    if (!fields || depth > MAX_DEPTH) {
        return []
    }
    const paths: string[] = []
    for (const field of fields) {
        // a length field counts the array after it
        if (field.name.endsWith("_length") && NUMERIC.has(field.type)) {
            continue
        }
        const dims = field.dims ?? []
        if (NUMERIC.has(field.type)) {
            if (!dims.length) {
                paths.push(field.name)
            } else if (dims.length === 1) {
                const fixed = Number(dims[0])
                const count = Number.isInteger(fixed) ? (fixed <= FIXED_ARRAY_MAX ? fixed : 0) : field.type === "byte" ? 0 : ARRAY_ELEMENTS
                for (let index = 0; index < count; index++) {
                    paths.push(`${field.name}[${index}]`)
                }
            }
        } else if (!dims.length && field.type in schemas && !SKIPPED.has(field.type)) {
            for (const inner of numericFields(field.type, schemas, depth + 1)) {
                paths.push(`${field.name}.${inner}`)
            }
        }
    }
    return paths
}

/** A type that carries a blob (an image, a cloud, a map): never subscribed to just to plot a number out of it. */
export function isHeavyType(type: string, schemas: Schemas = lcmSchemas as Schemas, depth = 0): boolean {
    const fields = schemas[type]
    if (!fields || depth > MAX_DEPTH) {
        return false
    }
    return fields.some((field) => {
        const variable = (field.dims ?? []).some((dim) => !Number.isInteger(Number(dim)))
        // a byte or int8 array is pixels, points or map cells; a struct array is a list of them
        if (variable && (field.type === "byte" || field.type === "int8_t" || field.type in schemas)) {
            return true
        }
        return !field.dims?.length && field.type in schemas && isHeavyType(field.type, schemas, depth + 1)
    })
}

export interface PlottableTopic {
    topic: Topic
    fields: string[]
    /** one number (std_msgs.Float32 and friends) */
    scalar: boolean
}

/** The topics a plot can show: the one-number ones first, then any other light message with numbers in it, by name. */
export function plottableTopics(topics: Topic[], schemas: Schemas = lcmSchemas as Schemas): PlottableTopic[] {
    const found: PlottableTopic[] = []
    for (const topic of topics) {
        if (!(topic.type in schemas) || isHeavyType(topic.type, schemas)) {
            continue
        }
        const fields = numericFields(topic.type, schemas)
        if (fields.length) {
            found.push({ topic, fields, scalar: SCALAR_TYPES.has(topic.type) })
        }
    }
    return found.sort((a, b) => Number(b.scalar) - Number(a.scalar) || a.topic.name.localeCompare(b.topic.name))
}

/** "linear.x" → ["linear", "x"], "position[2]" → ["position", 2] */
export function parsePath(path: string): (string | number)[] {
    const parts: (string | number)[] = []
    for (const piece of path.split(".")) {
        const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(piece)
        if (!match) {
            return []
        }
        parts.push(match[1])
        for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
            parts.push(Number(index[1]))
        }
    }
    return parts
}

/** The number at `path` in a decoded message (a boolean is 0 / 1, an int64 a Number), or null when it isn't there. */
export function readField(message: LcmValue, path: string): number | null {
    let value: unknown = message
    for (const part of parsePath(path)) {
        if (value === null || value === undefined) {
            return null
        }
        value = (value as Record<string | number, unknown>)[part]
    }
    if (typeof value === "boolean") {
        return value ? 1 : 0
    }
    if (typeof value === "bigint") {
        return Number(value)
    }
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

// ---- a plot's settings ----

export type PlotStyle = "line" | "step" | "points" | "area"
export type Smoothing = "none" | "average" | "ema"
export type SeriesTransform = "none" | "rate" | "abs"

export interface PlotSeries {
    id: string
    /** the topic's key (dimos/<name>/<type>) */
    key: string
    /** the number inside the message (numericFields) */
    field: string
    color: string
    label?: string
    hidden?: boolean
    /** drawn against the right-hand axis */
    right?: boolean
    /** value × scale + offset (a unit change: rad → °, m → cm) */
    scale?: number
    offset?: number
    /** rate: its change per second; abs: its magnitude */
    transform?: SeriesTransform
}

export interface PlotConfig {
    id: number
    title: string
    series: PlotSeries[]
    /** how many seconds the x axis shows (and the buffer keeps) */
    historyS: number
    smoothing: Smoothing
    /** the moving average's window, or the EMA's time constant */
    smoothingS: number
    /** a fixed end of the y axis (null: fit the data) */
    yMin: number | null
    yMax: number | null
    logY: boolean
    style: PlotStyle
    lineWidth: number
    xLabel: string
    yLabel: string
    /** the right-hand axis's label (series marked `right`) */
    y2Label: string
    legend: boolean
    grid: boolean
    /** last / min / max / mean under the legend */
    stats: boolean
    /** the raw values faint behind the smoothed line */
    showRaw: boolean
    /** horizontal lines at these values (a limit, a target) */
    marks: number[]
    /** x axis: seconds before now, or the clock */
    clock: boolean
    /** at most this many messages a second per topic */
    maxHz: number
}

export const SERIES_COLORS = ["#4e9cff", "#ff8a3d", "#3ecf8e", "#e45ce0", "#f2c94c", "#56d4e8", "#ff5c6c", "#a78bfa"]

export const DEFAULT_PLOT: Omit<PlotConfig, "id"> = {
    title: "",
    series: [],
    historyS: 30,
    smoothing: "none",
    smoothingS: 0.5,
    yMin: null,
    yMax: null,
    logY: false,
    style: "line",
    lineWidth: 1.5,
    xLabel: "",
    yLabel: "",
    y2Label: "",
    legend: true,
    grid: true,
    stats: false,
    showRaw: true,
    marks: [],
    clock: false,
    maxHz: 60,
}

export const HISTORY_MIN_S = 1
export const HISTORY_MAX_S = 3600

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback

/** The plots as saved, made safe: unique positive ids, every setting in range, series with a key and a field. */
export function normalizePlots(saved: unknown): PlotConfig[] {
    const list = Array.isArray(saved) ? saved : []
    const seen = new Set<number>()
    const plots: PlotConfig[] = []
    for (const raw of list) {
        if (!raw || !Number.isInteger(raw.id) || raw.id <= 0 || seen.has(raw.id)) {
            continue
        }
        seen.add(raw.id)
        const seriesSeen = new Set<string>()
        const series: PlotSeries[] = (Array.isArray(raw.series) ? raw.series : [])
            .filter((one: PlotSeries) => one && typeof one.key === "string" && typeof one.field === "string" && typeof one.id === "string" && !seriesSeen.has(one.id) && seriesSeen.add(one.id))
            .map((one: PlotSeries, index: number) => ({
                id: one.id,
                key: one.key,
                field: one.field,
                color: text(one.color, SERIES_COLORS[index % SERIES_COLORS.length]),
                ...(typeof one.label === "string" && one.label ? { label: one.label } : {}),
                ...(one.hidden ? { hidden: true } : {}),
                ...(one.right ? { right: true } : {}),
                ...(finite(one.scale) && one.scale !== 1 ? { scale: one.scale } : {}),
                ...(finite(one.offset) && one.offset !== 0 ? { offset: one.offset } : {}),
                ...(one.transform === "rate" || one.transform === "abs" ? { transform: one.transform } : {}),
            }))
        const pick = <T,>(value: unknown, options: readonly T[], fallback: T): T => options.includes(value as T) ? value as T : fallback
        const yMin = finite(raw.yMin) ? raw.yMin : null
        const yMax = finite(raw.yMax) ? raw.yMax : null
        plots.push({
            id: raw.id,
            title: text(raw.title),
            series,
            historyS: finite(raw.historyS) ? Math.min(HISTORY_MAX_S, Math.max(HISTORY_MIN_S, raw.historyS)) : DEFAULT_PLOT.historyS,
            smoothing: pick(raw.smoothing, ["none", "average", "ema"] as const, DEFAULT_PLOT.smoothing),
            smoothingS: finite(raw.smoothingS) && raw.smoothingS > 0 ? Math.min(600, raw.smoothingS) : DEFAULT_PLOT.smoothingS,
            yMin: yMin !== null && yMax !== null && yMin >= yMax ? null : yMin,
            yMax,
            logY: raw.logY === true,
            style: pick(raw.style, ["line", "step", "points", "area"] as const, DEFAULT_PLOT.style),
            lineWidth: finite(raw.lineWidth) ? Math.min(6, Math.max(0.5, raw.lineWidth)) : DEFAULT_PLOT.lineWidth,
            xLabel: text(raw.xLabel),
            yLabel: text(raw.yLabel),
            y2Label: text(raw.y2Label),
            legend: raw.legend !== false,
            grid: raw.grid !== false,
            stats: raw.stats === true,
            showRaw: raw.showRaw !== false,
            marks: Array.isArray(raw.marks) ? raw.marks.filter(finite).slice(0, 8) : [],
            clock: raw.clock === true,
            maxHz: finite(raw.maxHz) ? Math.min(1000, Math.max(1, Math.round(raw.maxHz))) : DEFAULT_PLOT.maxHz,
        })
    }
    return plots
}

/** what a series is called: its own label, else the topic's name and the field (just the name for a one-number topic's "data") */
export function seriesLabel(series: PlotSeries, topicName: string): string {
    if (series.label) {
        return series.label
    }
    return series.field === "data" ? topicName : `${topicName} ${series.field}`
}

/** a new series' color: the first of the palette no other series on the plot has */
export function nextColor(series: PlotSeries[]): string {
    const used = new Set(series.map((one) => one.color))
    return SERIES_COLORS.find((color) => !used.has(color)) ?? SERIES_COLORS[series.length % SERIES_COLORS.length]
}

// ---- a series' samples ----

/** a series never keeps more than this many samples, however long its history (1 kHz for a minute) */
export const MAX_SAMPLES = 60_000

/** A ring of (time ms, value): pushes are O(1), the oldest fall off past the capacity or the history. */
export class SeriesBuffer {
    times: Float64Array
    values: Float64Array
    #start = 0
    length = 0
    constructor(capacity = 1024) {
        this.times = new Float64Array(capacity)
        this.values = new Float64Array(capacity)
    }
    get capacity() {
        return this.times.length
    }
    push(time: number, value: number) {
        if (this.length === this.capacity) {
            if (this.capacity < MAX_SAMPLES) {
                this.#grow(Math.min(MAX_SAMPLES, this.capacity * 2))
            } else {
                this.#start = (this.#start + 1) % this.capacity
                this.length--
            }
        }
        const at = (this.#start + this.length) % this.capacity
        this.times[at] = time
        this.values[at] = value
        this.length++
    }
    /** drops every sample older than `time` */
    dropBefore(time: number) {
        while (this.length && this.times[this.#start] < time) {
            this.#start = (this.#start + 1) % this.capacity
            this.length--
        }
    }
    clear() {
        this.#start = 0
        this.length = 0
    }
    /** the samples oldest first, as two plain arrays */
    toArrays(): { times: Float64Array; values: Float64Array } {
        const times = new Float64Array(this.length)
        const values = new Float64Array(this.length)
        for (let index = 0; index < this.length; index++) {
            const at = (this.#start + index) % this.capacity
            times[index] = this.times[at]
            values[index] = this.values[at]
        }
        return { times, values }
    }
    last(): { time: number; value: number } | null {
        if (!this.length) {
            return null
        }
        const at = (this.#start + this.length - 1) % this.capacity
        return { time: this.times[at], value: this.values[at] }
    }
    #grow(capacity: number) {
        const { times, values } = this.toArrays()
        this.times = new Float64Array(capacity)
        this.values = new Float64Array(capacity)
        this.times.set(times)
        this.values.set(values)
        this.#start = 0
    }
}

/** A series' value as plotted: scaled and offset, then its transform (rate needs the previous sample: null for the first). */
export function transformValues(times: Float64Array, values: Float64Array, series: Pick<PlotSeries, "scale" | "offset" | "transform">): Float64Array {
    const scale = series.scale ?? 1, offset = series.offset ?? 0
    const out = new Float64Array(values.length)
    for (let index = 0; index < values.length; index++) {
        const value = values[index] * scale + offset
        if (series.transform === "rate") {
            const dt = index ? (times[index] - times[index - 1]) / 1000 : 0
            out[index] = dt > 0 ? (value - (values[index - 1] * scale + offset)) / dt : NaN
        } else {
            out[index] = series.transform === "abs" ? Math.abs(value) : value
        }
    }
    return out
}

/** Smoothed values: a trailing moving average over `windowS` seconds, or an exponential one with that time constant. */
export function smooth(times: Float64Array, values: Float64Array, mode: Smoothing, windowS: number): Float64Array {
    if (mode === "none" || windowS <= 0 || values.length < 2) {
        return values
    }
    const out = new Float64Array(values.length)
    const windowMs = windowS * 1000
    if (mode === "average") {
        let sum = 0, count = 0, tail = 0
        for (let index = 0; index < values.length; index++) {
            if (Number.isFinite(values[index])) {
                sum += values[index]
                count++
            }
            while (times[tail] < times[index] - windowMs) {
                if (Number.isFinite(values[tail])) {
                    sum -= values[tail]
                    count--
                }
                tail++
            }
            out[index] = count ? sum / count : NaN
        }
        return out
    }
    let level = NaN
    for (let index = 0; index < values.length; index++) {
        const value = values[index]
        if (!Number.isFinite(value)) {
            out[index] = level
            continue
        }
        if (!Number.isFinite(level)) {
            level = value
        } else {
            const dt = Math.max(0, times[index] - times[index - 1])
            level += (1 - Math.exp(-dt / windowMs)) * (value - level)
        }
        out[index] = level
    }
    return out
}

/**
 * The points worth drawing between `t0` and `t1` across `columns` pixel columns: every point when there are few, else
 * each column's first, lowest, highest and last (the line looks the same, with at most 4 points a column). The point
 * just before `t0` and just after `t1` are kept, so the line runs to the edges.
 */
export function decimate(times: Float64Array, values: Float64Array, t0: number, t1: number, columns: number): { times: number[]; values: number[] } {
    let first = 0
    while (first < times.length && times[first] < t0) {
        first++
    }
    first = Math.max(0, first - 1)
    let end = first
    while (end < times.length && times[end] <= t1) {
        end++
    }
    end = Math.min(times.length, end + 1)
    const outT: number[] = [], outV: number[] = []
    if (end - first <= columns * 4) {
        for (let index = first; index < end; index++) {
            outT.push(times[index])
            outV.push(values[index])
        }
        return { times: outT, values: outV }
    }
    const span = Math.max(1e-9, t1 - t0)
    let column = -1, firstAt = -1, minAt = -1, maxAt = -1, lastAt = -1
    const flush = () => {
        if (firstAt < 0) {
            return
        }
        for (const at of [...new Set([firstAt, minAt, maxAt, lastAt])].sort((a, b) => a - b)) {
            outT.push(times[at])
            outV.push(values[at])
        }
    }
    for (let index = first; index < end; index++) {
        const at = Math.floor(((times[index] - t0) / span) * columns)
        if (at !== column) {
            flush()
            column = at
            firstAt = minAt = maxAt = lastAt = index
            continue
        }
        lastAt = index
        const value = values[index]
        if (Number.isFinite(value)) {
            if (!Number.isFinite(values[minAt]) || value < values[minAt]) {
                minAt = index
            }
            if (!Number.isFinite(values[maxAt]) || value > values[maxAt]) {
                maxAt = index
            }
        }
    }
    flush()
    return { times: outT, values: outV }
}

export interface SeriesStats {
    last: number
    min: number
    max: number
    mean: number
    count: number
}

/** last / min / max / mean of the finite values (null with none) */
export function seriesStats(values: ArrayLike<number>): SeriesStats | null {
    let min = Infinity, max = -Infinity, sum = 0, count = 0, last = NaN
    for (let index = 0; index < values.length; index++) {
        const value = values[index]
        if (!Number.isFinite(value)) {
            continue
        }
        min = Math.min(min, value)
        max = Math.max(max, value)
        sum += value
        count++
        last = value
    }
    return count ? { last, min, max, mean: sum / count, count } : null
}

// ---- the axes ----

/**
 * The y range to draw: a fixed end where one is set, else the data's (5% padding; a flat line gets ±1 or ±10% of
 * itself). On a log axis only positive values count, and the range snaps out to whole decades when it spans more than one.
 */
export function yRange(min: number, max: number, fixed: { yMin: number | null; yMax: number | null; logY: boolean }): [number, number] {
    let low = fixed.yMin ?? min, high = fixed.yMax ?? max
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
        return fixed.logY ? [1, 10] : [0, 1]
    }
    if (fixed.logY) {
        low = low > 0 ? low : high > 0 ? high / 10 : 1
        high = high > low ? high : low * 10
        const decades = Math.log10(high) - Math.log10(low)
        return [fixed.yMin ?? (decades > 1 ? 10 ** Math.floor(Math.log10(low)) : low / 1.1), fixed.yMax ?? (decades > 1 ? 10 ** Math.ceil(Math.log10(high)) : high * 1.1)]
    }
    if (high === low) {
        const pad = Math.abs(low) * 0.1 || 1
        return [fixed.yMin ?? low - pad, fixed.yMax ?? high + pad]
    }
    const pad = (high - low) * 0.05
    return [fixed.yMin ?? low - pad, fixed.yMax ?? high + pad]
}

/** about `count` round ticks across [min, max] (1, 2 or 5 × a power of ten apart) */
export function niceTicks(min: number, max: number, count = 5): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return []
    }
    const rough = (max - min) / Math.max(1, count)
    const power = 10 ** Math.floor(Math.log10(rough))
    const step = [1, 2, 5, 10].map((multiple) => multiple * power).find((candidate) => candidate >= rough) ?? 10 * power
    const ticks: number[] = []
    for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
        // -0 and float dust (0.30000000000000004) out
        ticks.push(Number((Math.abs(tick) < step * 1e-9 ? 0 : tick).toPrecision(12)))
    }
    return ticks
}

/** a log axis's ticks: every decade, with 2 and 5 between them when it spans few decades */
export function logTicks(min: number, max: number): number[] {
    if (!(min > 0) || !(max > min)) {
        return []
    }
    const lowest = Math.floor(Math.log10(min)), highest = Math.ceil(Math.log10(max))
    const decades = highest - lowest
    const every = Math.max(1, Math.ceil(decades / 8))
    const ticks: number[] = []
    for (let power = lowest; power <= highest; power += every) {
        for (const multiple of decades <= 3 ? [1, 2, 5] : [1]) {
            const tick = Number((multiple * 10 ** power).toPrecision(12))
            if (tick >= min * (1 - 1e-9) && tick <= max * (1 + 1e-9)) {
                ticks.push(tick)
            }
        }
    }
    return ticks
}

/** a tick's or a reading's text: short (1.5k, 2e-5), enough digits to tell neighbours apart */
export function formatNumber(value: number, step = Math.abs(value) || 1): string {
    if (!Number.isFinite(value)) {
        return "–"
    }
    const magnitude = Math.abs(value)
    if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-4)) {
        return value.toExponential(magnitude >= 1e6 ? 2 : 1).replace("e+", "e")
    }
    if (magnitude >= 10_000) {
        return `${Number((value / 1000).toPrecision(4))}k`
    }
    const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step) || 1)) + (step < 1 ? 1 : 0)))
    return Number(value.toFixed(decimals)).toString()
}

/** A plot's samples as CSV: a time column (ISO) and one column per series, a row per sample. */
export function plotCsv(columns: { label: string; times: ArrayLike<number>; values: ArrayLike<number> }[]): string {
    const rows: string[] = [["time", ...columns.map((column) => `"${column.label.replaceAll('"', '""')}"`)].join(",")]
    const cells: Map<number, (number | null)[]> = new Map()
    columns.forEach((column, index) => {
        for (let at = 0; at < column.times.length; at++) {
            const time = column.times[at]
            const row = cells.get(time) ?? columns.map(() => null)
            row[index] = column.values[at]
            cells.set(time, row)
        }
    })
    for (const time of [...cells.keys()].sort((a, b) => a - b)) {
        rows.push([new Date(time).toISOString(), ...cells.get(time)!.map((value) => value === null || !Number.isFinite(value) ? "" : String(value))].join(","))
    }
    return rows.join("\n") + "\n"
}
