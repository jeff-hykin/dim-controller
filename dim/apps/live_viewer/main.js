// Live Viewer — backend half. A PimSim-style 3D scene for a LIVE DimOS stack:
// discovers robot streams on the bridge, decodes them (@dimos/msgs), and forwards
// compact frames to the 3D frontend. Stream *types* aren't always in the meter
// key, so the kind (cloud / odom / tf / path / image) is duck-typed from the
// decoded message. Robot access only via the bridge (ctx.Dimos).

import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"
import { decode } from "jsr:@dimos/msgs@0.1.4"
import lz4 from "https://esm.sh/lz4js@0.2.0"

const dimApp = new DimAppBackend()
const ctx = dimContext()

const METER = "__meta/streams"

const MAX_PTS = 24000
// Only the newest message per stream is ever sent; while the socket is backed up past
// this many bytes everything queued behind it is dropped, so the viewer stays live
// instead of falling minutes behind replaying stale frames.
const HIGH_WATER = 1 << 20
const DRAIN_MS = 16

let watched = new Set()
let dataConn = null
const pending = new Map()   // stream -> newest undelivered { kind, msg }
let droppedCount = 0

// Duck-type a decoded message into a render kind.
function kindOfMsg(m) {
    if (!m || typeof m !== "object") return null
    if (Array.isArray(m.fields) && (m.point_step || m.width)) return "cloud"
    if (m.pose && m.pose.pose && m.pose.pose.position) return "odom"
    if (Array.isArray(m.transforms)) return "tf"
    if (Array.isArray(m.poses)) return "path"
    if (m.format !== undefined && m.width === undefined) return "image"
    if (m.width !== undefined && m.height !== undefined && m.encoding !== undefined && m.data !== undefined) return "image"
    return null
}
// Watch every stream on the bus except internal meta streams; the render kind is
// decided by duck-typing the decoded message, so there is no name list at all.
const isWatchable = (s) => !s.startsWith("__")

function toB64(bytes) {
    let bin = ""
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    return btoa(bin)
}
function asBytes(d) {
    if (d instanceof Uint8Array) return d
    if (d?.buffer) return new Uint8Array(d.buffer, d.byteOffset ?? 0, d.byteLength ?? d.length)
    if (Array.isArray(d)) return Uint8Array.from(d)
    return new Uint8Array(0)
}
function frameId(msg) { return msg?.header?.frame_id || "" }

// A stream can be published through a codec chain ("lz4+lcm"), and the chain is named
// nowhere on the wire — but an LCM payload never starts with the LZ4 frame magic, so the
// wrapper is stripped by sniffing the bytes. Without this, cloud_map / depth_image throw
// "unknown message hash" inside the socket handler and vanish with no trace.
const LZ4_MAGIC = [0x04, 0x22, 0x4d, 0x18]
let undecodableCount = 0
function decodeMessage(payload) {
    try {
        let bytes = asBytes(payload)
        if (LZ4_MAGIC.every((byte, index) => bytes[index] === byte)) { bytes = new Uint8Array(lz4.decompress(bytes)) }
        return decode(bytes)
    } catch {
        undecodableCount++
        return null
    }
}

// Picture bytes reach the viewer two ways: a CompressedImage (a `format` field, no
// dimensions) or an ordinary Image envelope whose `encoding` names a picture format
// instead of a pixel layout (step is 0 there). Either way the browser decodes it, so it
// must not go down the raw-pixel path. Format strings are loose in the wild — "png",
// "image/png", "rgb8; jpeg compressed bgr8" — so any recognized word wins.
const PICTURE_FORMATS = new Set(["jpeg", "png", "webp", "jxl", "avif", "gif", "bmp"])
function pictureFormat(name) {
    for (const word of String(name || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
        const format = word === "jpg" ? "jpeg" : word
        if (PICTURE_FORMATS.has(format)) { return format }
    }
    return null
}

function parseCloud(msg) {
    const fields = msg.fields || []
    const fx = fields.find((f) => f.name === "x"), fy = fields.find((f) => f.name === "y"), fz = fields.find((f) => f.name === "z")
    const step = msg.point_step | 0
    if (!fx || !fy || !fz || !step) return null
    const data = asBytes(msg.data)
    const total = Math.floor(data.byteLength / step)
    if (!total) return null
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const le = !msg.is_bigendian
    const rd = (off, dt) => (dt === 8 ? dv.getFloat64(off, le) : dv.getFloat32(off, le))
    const stride = Math.max(1, Math.ceil(total / MAX_PTS))
    const out = new Float32Array(Math.ceil(total / stride) * 3)
    let k = 0
    for (let i = 0; i < total; i += stride) {
        const base = i * step
        const x = rd(base + fx.offset, fx.datatype), y = rd(base + fy.offset, fy.datatype), z = rd(base + fz.offset, fz.datatype)
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue
        out[k * 3] = x; out[k * 3 + 1] = y; out[k * 3 + 2] = z; k++
    }
    return { n: k, b64: toB64(new Uint8Array(out.buffer, 0, k * 3 * 4)) }
}
function parsePath(msg) {
    const poses = msg.poses || []
    const out = new Float32Array(poses.length * 3)
    let k = 0
    for (const ps of poses) {
        const p = ps?.pose?.position
        if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue
        out[k * 3] = p.x; out[k * 3 + 1] = p.y; out[k * 3 + 2] = p.z; k++
    }
    return { n: k, b64: toB64(new Uint8Array(out.buffer, 0, k * 3 * 4)) }
}

// Newest message wins: an unsent message for the same stream is simply overwritten.
// tf is the exception — transforms are incremental state, so they go straight out.
function forward(stream, msg) {
    const kind = kindOfMsg(msg)
    if (!kind) return
    if (kind === "tf") { send(stream, kind, msg); return }
    if (pending.has(stream)) { droppedCount++ }
    pending.set(stream, { kind, msg })
}
// Serializing is the expensive part (point striding + base64), so it happens here at
// send time rather than on arrival — dropped messages cost nothing.
function send(stream, kind, msg) {
    if (kind === "cloud") {
        const c = parseCloud(msg)
        if (c) dimApp.send("cloud", { stream, frame: frameId(msg), n: c.n, b64: c.b64 })
    } else if (kind === "odom") {
        const p = msg.pose.pose.position, q = msg.pose.pose.orientation
        if (!p || !q) return
        dimApp.send("odom", { stream, frame: frameId(msg), pos: [p.x, p.y, p.z], quat: [q.x, q.y, q.z, q.w] })
    } else if (kind === "tf") {
        const transforms = (msg.transforms || []).map((t) => ({
            parent: t?.header?.frame_id || "", child: t.child_frame_id || "",
            t: [t.transform.translation.x, t.transform.translation.y, t.transform.translation.z],
            q: [t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w],
        }))
        if (transforms.length) dimApp.send("tf", { transforms })
    } else if (kind === "path") {
        const pl = parsePath(msg)
        dimApp.send("path", { stream, frame: frameId(msg), n: pl.n, b64: pl.b64 })
    } else if (kind === "image") {
        try {
            const isCompressedImage = msg.width === undefined
            const format = pictureFormat(isCompressedImage ? msg.format : msg.encoding)
            if (format || isCompressedImage) {
                dimApp.send("frame", { stream, kind: "compressed", format: format || "jpeg", b64: toB64(asBytes(msg.data)) })
            } else {
                dimApp.send("frame", {
                    stream, kind: "raw", encoding: String(msg.encoding || ""),
                    width: msg.width | 0, height: msg.height | 0, step: msg.step | 0,
                    bigendian: !!msg.is_bigendian, b64: toB64(asBytes(msg.data)),
                })
            }
        } catch { /* unserializable frame — skip */ }
    }
}

// The dim-app SDK sends straight to the socket with no flow control, so pacing has to
// come from the socket's own backlog: nothing new goes out until it has drained.
const backlog = () => dimApp._ws?.bufferedAmount ?? 0
setInterval(() => {
    if (!pending.size) return
    for (const [stream, { kind, msg }] of pending) {
        if (backlog() > HIGH_WATER) return   // stay queued; a newer message may replace it
        pending.delete(stream)
        try { send(stream, kind, msg) } catch { /* undecodable message — drop it */ }
    }
}, DRAIN_MS)

// Report how much is being dropped, so a saturated link is visible instead of just
// looking like a slow robot, and how much can't be decoded at all.
let reportedDrops = 0
setInterval(() => {
    const rate = droppedCount - reportedDrops
    reportedDrops = droppedCount
    dimApp.send("status", { bridge: !!dataConn || watched.size > 0, dropped: rate, undecodable: undecodableCount })
}, 1000)

function connectData(streams) {
    try { dataConn?.close() } catch { /* closed */ }
    dataConn = null
    if (!streams.length || !ctx?.Dimos?.connect) return
    ctx.Dimos.connect({
        dimosWs: {
            host: ctx.bridge.host, port: ctx.bridge.port, whitelist: streams,
            rateLimit: Object.fromEntries(streams.map((s) => [s, 20])),
        },
        decode: decodeMessage,
    }).then((conn) => {
        dataConn = conn
        conn.subscribeAll((m) => { if (m?.data) forward(m.stream, m.data) })
    }).catch(() => { dataConn = null; setTimeout(() => connectData([...watched]), 3000) })
}

function connectMeter() {
    if (!ctx?.Dimos?.connect) { dimApp.send("status", { bridge: false }); return }
    ctx.Dimos.connect({ dimosWs: { host: ctx.bridge.host, port: ctx.bridge.port, whitelist: [METER] } })
        .then((conn) => {
            let lastSeen = Date.now()
            dimApp.send("status", { bridge: true })
            conn.subscribeAll((m) => {
                lastSeen = Date.now()
                if (m.stream !== METER) return
                let snap
                try { snap = JSON.parse(new TextDecoder().decode(asBytes(m.data))) } catch { return }
                const next = new Set(Object.keys(snap?.streams || {}).filter(isWatchable))
                const changed = next.size !== watched.size || [...next].some((s) => !watched.has(s))
                if (changed) {
                    watched = next
                    connectData([...next])   // subscribe to all; the frontend lists a stream once it renders
                }
            })
            const watch = setInterval(() => {
                if (Date.now() - lastSeen > 6000) {
                    clearInterval(watch); dimApp.send("status", { bridge: false })
                    try { conn.close() } catch { /* closed */ }
                    watched = new Set(); connectMeter()
                }
            }, 3000)
        })
        .catch(() => { dimApp.send("status", { bridge: false }); setTimeout(connectMeter, 3000) })
}
connectMeter()

dimApp.onReceive((kind) => {
    if (kind === "hello") {
        dimApp.send("status", { bridge: !!dataConn || watched.size > 0 })
    }
})
