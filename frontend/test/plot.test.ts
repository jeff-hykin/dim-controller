// The Plot panel's data (core/plot.ts): the numbers a message type offers, reading one, the plottable topics, saved
// plots made safe, the sample ring, smoothing, decimation, the y range and ticks, and CSV.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import {
    decimate,
    isHeavyType,
    logTicks,
    MAX_SAMPLES,
    niceTicks,
    normalizePlots,
    numericFields,
    parsePath,
    plotCsv,
    plottableTopics,
    readField,
    SeriesBuffer,
    seriesStats,
    smooth,
    transformValues,
    yRange,
} from "../src/core/plot.ts"
import { parseKey, type Topic } from "../src/core/transport.ts"

const topic = (name: string, type: string): Topic => parseKey(`dimos/${name}/${type}`)!

Deno.test("numericFields: one-number types, nested messages, fixed and variable arrays", () => {
    assertEquals(numericFields("std_msgs.Float32"), ["data"])
    assertEquals(numericFields("std_msgs.Bool"), ["data"])
    assertEquals(numericFields("geometry_msgs.Twist"), ["linear.x", "linear.y", "linear.z", "angular.x", "angular.y", "angular.z"])
    // a header's seq / stamp are skipped; a 36-number covariance offers nothing
    const odometry = numericFields("nav_msgs.Odometry")
    assert(odometry.includes("pose.pose.position.x"))
    assert(odometry.includes("twist.twist.angular.z"))
    assert(!odometry.some((path) => path.startsWith("header")))
    assert(!odometry.some((path) => path.includes("covariance")))
    // a variable array: its first elements, never its length field
    const multi = numericFields("std_msgs.Float64MultiArray")
    assert(multi.includes("data[0]") && multi.includes("data[7]") && !multi.includes("data[8]"))
    assert(!multi.includes("data_length"))
    assertEquals(numericFields("no_such.Type"), [])
})

Deno.test("isHeavyType: images, clouds and maps are never subscribed to for a plot", () => {
    assert(isHeavyType("sensor_msgs.Image"))
    assert(isHeavyType("sensor_msgs.PointCloud2"))
    assert(isHeavyType("nav_msgs.OccupancyGrid"))
    assert(!isHeavyType("std_msgs.Float64"))
    assert(!isHeavyType("nav_msgs.Odometry"))
})

Deno.test("plottableTopics: one-number topics first, heavy and unknown ones left out", () => {
    const found = plottableTopics([
        topic("odom", "nav_msgs.Odometry"),
        topic("camera", "sensor_msgs.Image"),
        topic("speed", "std_msgs.Float32"),
        topic("weird", "x.Unknown"),
        topic("armed", "std_msgs.Bool"),
    ])
    assertEquals(found.map((one) => one.topic.name), ["/armed", "/speed", "/odom"])
    assertEquals(found[0].scalar, true)
    assertEquals(found[2].scalar, false)
})

Deno.test("parsePath and readField", () => {
    assertEquals(parsePath("pose.position[2]"), ["pose", "position", 2])
    assertEquals(parsePath("bad]["), [])
    const message = { data: 3.5, flag: true, big: 12n, linear: { x: -1 }, position: [1, 2, 3], nan: NaN }
    assertEquals(readField(message, "data"), 3.5)
    assertEquals(readField(message, "flag"), 1)
    assertEquals(readField(message, "big"), 12)
    assertEquals(readField(message, "linear.x"), -1)
    assertEquals(readField(message, "position[2]"), 3)
    assertEquals(readField(message, "missing.deeper"), null)
    assertEquals(readField(message, "nan"), null)
})

Deno.test("normalizePlots: bad entries dropped, settings clamped, defaults filled", () => {
    const plots = normalizePlots([
        { id: 1, series: [{ id: "a", key: "dimos/x/std_msgs.Float32", field: "data" }, { id: "a", key: "k", field: "f" }, { key: "no id" }], historyS: 99999, yMin: 5, yMax: 2, style: "bars", maxHz: 0 },
        { id: 1 },
        { id: -2 },
        null,
        { id: 3, logY: true, marks: [1, "x", 2] },
    ])
    assertEquals(plots.map((plot) => plot.id), [1, 3])
    assertEquals(plots[0].series.length, 1)
    assert(plots[0].series[0].color.startsWith("#"))
    assertEquals(plots[0].historyS, 3600)
    // min over max: the min goes back to auto
    assertEquals(plots[0].yMin, null)
    assertEquals(plots[0].yMax, 2)
    assertEquals(plots[0].style, "line")
    assertEquals(plots[0].maxHz, 1)
    assertEquals(plots[1].logY, true)
    assertEquals(plots[1].marks, [1, 2])
    assertEquals(normalizePlots("nope"), [])
})

Deno.test("SeriesBuffer: grows, drops by time, caps at MAX_SAMPLES", () => {
    const buffer = new SeriesBuffer(2)
    for (let time = 0; time < 10; time++) {
        buffer.push(time, time * 10)
    }
    assertEquals(buffer.length, 10)
    buffer.dropBefore(4)
    const { times, values } = buffer.toArrays()
    assertEquals([...times], [4, 5, 6, 7, 8, 9])
    assertEquals([...values], [40, 50, 60, 70, 80, 90])
    assertEquals(buffer.last(), { time: 9, value: 90 })
    const full = new SeriesBuffer(MAX_SAMPLES)
    for (let time = 0; time < MAX_SAMPLES + 5; time++) {
        full.push(time, time)
    }
    assertEquals(full.length, MAX_SAMPLES)
    assertEquals(full.toArrays().times[0], 5)
    full.clear()
    assertEquals(full.length, 0)
})

Deno.test("transformValues: scale, offset, rate per second, magnitude", () => {
    const times = new Float64Array([0, 1000, 2000])
    const values = new Float64Array([1, 3, -2])
    assertEquals([...transformValues(times, values, { scale: 2, offset: 1 })], [3, 7, -3])
    const rate = transformValues(times, values, { transform: "rate" })
    assert(Number.isNaN(rate[0]))
    assertEquals([...rate.slice(1)], [2, -5])
    assertEquals([...transformValues(times, values, { transform: "abs" })], [1, 3, 2])
})

Deno.test("smooth: a moving average over the time window, an EMA that settles", () => {
    const times = new Float64Array([0, 100, 200, 300, 400])
    const values = new Float64Array([0, 10, 0, 10, 0])
    assertEquals(smooth(times, values, "none", 1), values)
    // a 0.15 s window: each point and the one before it
    assertEquals([...smooth(times, values, "average", 0.15)], [0, 5, 5, 5, 5])
    const step = smooth(new Float64Array([0, 1000, 2000, 30000]), new Float64Array([0, 10, 10, 10]), "ema", 1)
    assertEquals(step[0], 0)
    assertAlmostEquals(step[1], 10 * (1 - Math.exp(-1)), 1e-9)
    assertAlmostEquals(step[3], 10, 1e-6)
})

Deno.test("decimate: few points pass through, many keep each column's extremes", () => {
    const times = new Float64Array([0, 1, 2, 3])
    const values = new Float64Array([1, 2, 3, 4])
    assertEquals(decimate(times, values, 1, 2, 100).times, [0, 1, 2, 3])
    const n = 10_000
    const manyT = new Float64Array(n).map((_, index) => index)
    const manyV = new Float64Array(n).map((_, index) => index === 5000 ? 999 : Math.sin(index))
    const thin = decimate(manyT, manyV, 0, n, 50)
    assert(thin.times.length <= 50 * 4 + 4)
    // the spike survives
    assert(thin.values.includes(999))
})

Deno.test("seriesStats", () => {
    assertEquals(seriesStats([1, NaN, 3, 2]), { last: 2, min: 1, max: 3, mean: 2, count: 3 })
    assertEquals(seriesStats([]), null)
})

Deno.test("yRange: padding, a flat line, fixed ends, log decades", () => {
    assertEquals(yRange(0, 10, { yMin: null, yMax: null, logY: false }), [-0.5, 10.5])
    assertEquals(yRange(5, 5, { yMin: null, yMax: null, logY: false }), [4.5, 5.5])
    assertEquals(yRange(0, 0, { yMin: null, yMax: null, logY: false }), [-1, 1])
    assertEquals(yRange(0, 10, { yMin: -2, yMax: null, logY: false }), [-2, 10.6])
    assertEquals(yRange(3, 4000, { yMin: null, yMax: null, logY: true }), [1, 10000])
    assertEquals(yRange(NaN, NaN, { yMin: null, yMax: null, logY: false }), [0, 1])
})

Deno.test("niceTicks and logTicks", () => {
    assertEquals(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10])
    assertEquals(niceTicks(-0.25, 0.25, 5), [-0.2, -0.1, 0, 0.1, 0.2])
    assertEquals(niceTicks(1, 1), [])
    assertEquals(logTicks(1, 1000), [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000])
    assertEquals(logTicks(1, 1e8).length, 9)
    assertEquals(logTicks(0, 10), [])
})

Deno.test("plotCsv: one row per time, a column per series", () => {
    const csv = plotCsv([
        { label: "a", times: [0, 1000], values: [1, 2] },
        { label: 'b "q"', times: [1000], values: [NaN] },
    ])
    assertEquals(csv.split("\n")[0], 'time,"a","b ""q"""')
    assertEquals(csv.split("\n")[1], "1970-01-01T00:00:00.000Z,1,")
    assertEquals(csv.split("\n")[2], "1970-01-01T00:00:01.000Z,2,")
})
