// Live Viewer — backend half. A PimSim-style 3D scene for a LIVE DimOS stack:
// discovers robot streams on the bridge, decodes them (@dimos/msgs), and forwards
// compact frames to the 3D frontend. Stream *types* aren't always in the meter
// key, so the kind (cloud / odom / tf / path / image) is duck-typed from the
// decoded message. Robot access only via the bridge (ctx.Dimos).

import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"
import { decode } from "jsr:@dimos/msgs@0.1.4"

const dimApp = new DimAppBackend()
const ctx = dimContext()

const METER = "__meta/streams"

const MAX_PTS = 24000
const CLOUD_HZ = 8
const IMG_HZ = 10
const PATH_HZ = 10

let watched = new Set()
let dataConn = null
const lastSent = new Map()

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
function rl(stream, hz) {
    const now = Date.now()
    if (now - (lastSent.get(stream) || 0) < 1000 / hz) return false
    lastSent.set(stream, now)
    return true
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

function forward(stream, msg) {
    const kind = kindOfMsg(msg)
    if (kind === "cloud") {
        if (!rl(stream, CLOUD_HZ)) return
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
        if (!rl(stream, PATH_HZ)) return
        const pl = parsePath(msg)
        dimApp.send("path", { stream, frame: frameId(msg), n: pl.n, b64: pl.b64 })
    } else if (kind === "image") {
        if (!rl(stream, IMG_HZ)) return
        try {
            if (msg.format !== undefined && msg.width === undefined) {
                dimApp.send("frame", { stream, kind: "compressed", format: String(msg.format || "jpeg"), b64: toB64(asBytes(msg.data)) })
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

function connectData(streams) {
    try { dataConn?.close() } catch { /* closed */ }
    dataConn = null
    if (!streams.length || !ctx?.Dimos?.connect) return
    ctx.Dimos.connect({
        dimosWs: {
            host: ctx.bridge.host, port: ctx.bridge.port, whitelist: streams,
            rateLimit: Object.fromEntries(streams.map((s) => [s, 20])),
        },
        decode,
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
