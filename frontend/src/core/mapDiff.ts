// A global map kept from diffs: a ray tracer in diff mode publishes only what changed on map_update (a sensor_msgs.PointCloud2
// with a u8 `change` field, 1 added / 0 removed, beside `premap`), and the whole map on global_map only when asked on
// cloud_keyframe_request. The map is the last keyframe with every later diff applied in order.
import { decode, encode } from "./lcm/lcm.ts"
import { type Connection, dimosKey, type Topic } from "./transport.ts"
import type { Publisher } from "../vendor/zenoh-gateway/zenoh_gateway.ts"

/** How often the keyframe is asked for again until it comes (a whole map can take seconds to arrive). */
const KEYFRAME_ASK_MS = 10_000

/** A cloud's points as read off the wire: xyz, and each u8 flag field it carries. */
export interface FlaggedCloud {
    positions: Float32Array
    premap: Uint8Array | null
    change: Uint8Array | null
    frameId: string
    /** the header stamp (ms), null when unstamped */
    stampMs: number | null
}

interface RawField {
    name: string
    offset: number
    datatype: number
}

const FLOAT32 = 7
const UINT8 = 2

/** Reads xyz and the `premap` / `change` u8 fields of a raw sensor_msgs.PointCloud2. */
export function readFlaggedCloud(bytes: Uint8Array): FlaggedCloud {
    const msg = decode("sensor_msgs.PointCloud2", bytes) as {
        header: { frame_id: string; stamp: { sec: number; nsec: number } }
        width: number
        height: number
        point_step: number
        is_bigendian: boolean
        fields: RawField[]
        data: Uint8Array
    }
    const count = msg.width * msg.height
    const view = new DataView(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)
    const field = (name: string, datatype: number) => msg.fields.find((f) => f.name === name && f.datatype === datatype)?.offset ?? null
    const [x, y, z] = ["x", "y", "z"].map((name) => field(name, FLOAT32))
    if (x === null || y === null || z === null) {
        throw new Error("a cloud without float32 x, y, z")
    }
    const positions = new Float32Array(count * 3)
    for (let index = 0; index < count; index++) {
        const base = index * msg.point_step
        positions[index * 3] = view.getFloat32(base + x, !msg.is_bigendian)
        positions[index * 3 + 1] = view.getFloat32(base + y, !msg.is_bigendian)
        positions[index * 3 + 2] = view.getFloat32(base + z, !msg.is_bigendian)
    }
    const flags = (name: string) => {
        const offset = field(name, UINT8)
        if (offset === null) {
            return null
        }
        const out = new Uint8Array(count)
        for (let index = 0; index < count; index++) {
            out[index] = msg.data[index * msg.point_step + offset]
        }
        return out
    }
    const { sec, nsec } = msg.header.stamp
    return { positions, premap: flags("premap"), change: flags("change"), frameId: msg.header.frame_id, stampMs: sec > 0 ? sec * 1000 + nsec / 1e6 : null }
}

/** The map a keyframe and the diffs after it make: voxel center → premap flag. */
export class DiffMap {
    #voxels = new Map<string, { x: number; y: number; z: number; premap: number }>()
    /** the keyframe's stamp (ms); null before one came */
    keyframeStampMs: number | null = null
    frameId = ""
    removedTotal = 0

    get size() {
        return this.#voxels.size
    }

    /** The whole map, replacing whatever was kept. */
    applyKeyframe(cloud: FlaggedCloud) {
        this.#voxels.clear()
        this.#put(cloud, () => true)
        this.keyframeStampMs = cloud.stampMs ?? 0
        this.frameId = cloud.frameId
    }

    /** One diff; false (and nothing changes) before a keyframe, or for a diff older than it (the keyframe already holds it). */
    applyDiff(cloud: FlaggedCloud): boolean {
        if (this.keyframeStampMs === null || !cloud.change || (cloud.stampMs !== null && cloud.stampMs < this.keyframeStampMs)) {
            return false
        }
        const change = cloud.change
        this.#put(cloud, (index) => change[index] !== 0)
        for (let index = 0; index < change.length; index++) {
            if (change[index] === 0 && this.#voxels.delete(keyOf(cloud.positions, index))) {
                this.removedTotal++
            }
        }
        this.frameId = cloud.frameId
        return true
    }

    #put(cloud: FlaggedCloud, take: (index: number) => boolean) {
        const p = cloud.positions
        for (let index = 0; index < p.length / 3; index++) {
            if (take(index)) {
                this.#voxels.set(keyOf(p, index), { x: p[index * 3], y: p[index * 3 + 1], z: p[index * 3 + 2], premap: cloud.premap?.[index] ?? 0 })
            }
        }
    }

    positions(): Float32Array {
        const out = new Float32Array(this.#voxels.size * 3)
        let at = 0
        for (const voxel of this.#voxels.values()) {
            out[at++] = voxel.x
            out[at++] = voxel.y
            out[at++] = voxel.z
        }
        return out
    }

    premapCount(): number {
        let count = 0
        for (const voxel of this.#voxels.values()) {
            count += voxel.premap
        }
        return count
    }
}

/** Voxel centers are exact floats from the same grid, so their bits are the key. */
const keyOf = (p: Float32Array, index: number) => `${p[index * 3]},${p[index * 3 + 1]},${p[index * 3 + 2]}`

/** The topic beside `topic` with another last name (/robot/global_map → /robot/map_update). */
export const siblingName = (topic: Topic, last: string) => topic.name.replace(/[^/]+$/, last)

/** A ray tracer's diff topic: the global map is drawn from it (its global_map only carries keyframes, so may never show on the bus). */
export const isDiffTopic = (topic: Topic) => /(^|\/)map_update$/.test(topic.name) && topic.type === "sensor_msgs.PointCloud2"

/** Whether a global map has a map_update beside it, which draws the map in its place. */
export const hasDiffTopic = (topic: Topic, topics: Topic[]) => topics.some((other) => isDiffTopic(other) && other.name === siblingName(topic, "map_update"))

/** What MapDiffFeed tells the page (debugHook reads it). */
export let lastMapDiff: { keyframes: number; diffs: number; staleDiffs: number; requests: number; voxels: number; removedTotal: number; premap: number; keyframeVoxels: number | null; voxelsBeforeKeyframe: number | null } | null = null

/** The feeds running now, so the page can start them all again from a keyframe. */
const feeds = new Set<MapDiffFeed>()

/** Ask every global map kept from diffs for a fresh keyframe. */
export function requestKeyframes() {
    feeds.forEach((feed) => feed.requestKeyframe())
}

/**
 * Keeps a global map from its diffs: asks for a keyframe on cloud_keyframe_request (true) when it starts and every
 * askEveryMs until one comes (and again on a reconnect), takes global_map whole and map_update reliably and raw (a thinned or skipped diff
 * would leave the map wrong for good), and hands the map on after each change.
 */
export class MapDiffFeed {
    readonly map = new DiffMap()
    #stops: (() => void)[] = []
    #publisher: Publisher | null = null
    #asking: ReturnType<typeof setInterval> | null = null
    #counts = { keyframes: 0, diffs: 0, staleDiffs: 0, requests: 0, keyframeVoxels: null as number | null, voxelsBeforeKeyframe: null as number | null }
    #sampled = { messages: 0, bytes: 0, since: performance.now() }

    constructor(readonly connection: Connection, readonly update: Topic, readonly onMap: (map: DiffMap, stampMs: number | null, arrivedAt: number) => void, readonly askEveryMs = KEYFRAME_ASK_MS) {
        this.#stops.push(connection.subscribe(dimosKey(siblingName(update, "global_map"), update.type), { delivery: "reliable" }, (message) => {
            this.#count(message.bytes)
            const cloud = this.#read(message.bytes)
            if (cloud) {
                // what the diffs had built, beside what the keyframe says the map is: equal when no diff went missing
                this.#counts.voxelsBeforeKeyframe = this.map.keyframeStampMs === null ? null : this.map.size
                this.map.applyKeyframe(cloud)
                this.#counts.keyframeVoxels = this.map.size
                this.#counts.keyframes++
                this.#stopAsking()
                this.#publish(cloud.stampMs, message.timestamp)
            }
        }))
        this.#stops.push(connection.subscribe(update.key, { delivery: "reliable" }, (message) => {
            this.#count(message.bytes)
            const cloud = this.#read(message.bytes)
            if (!cloud) {
                return
            }
            if (this.map.applyDiff(cloud)) {
                this.#counts.diffs++
                this.#publish(cloud.stampMs, message.timestamp)
            } else {
                this.#counts.staleDiffs++
            }
        }))
        // a reconnect may have missed diffs, so it starts again from a keyframe
        let connected = connection.status.get().state === "connected"
        this.#stops.push(connection.status.subscribe(() => {
            const now = connection.status.get().state === "connected"
            if (now && !connected) {
                this.#publisher = null
                this.requestKeyframe()
            }
            connected = now
        }))
        this.requestKeyframe()
        feeds.add(this)
    }

    /** Ask for the whole map again (a reset), every askEveryMs until it comes. */
    requestKeyframe() {
        this.#stopAsking()
        const ask = () => {
            try {
                const client = this.connection.client
                if (client && !this.#publisher) {
                    this.#publisher = client.publisher(dimosKey(siblingName(this.update, "cloud_keyframe_request"), "std_msgs.Bool"), { delivery: "reliable" })
                }
                this.#publisher?.put(encode("std_msgs.Bool", { data: true }))
                this.#counts.requests++
                this.#note()
            } catch {
                // not open yet: the next one goes
            }
        }
        this.#asking = setInterval(ask, this.askEveryMs)
        ask()
    }

    #read(bytes: Uint8Array): FlaggedCloud | null {
        try {
            return readFlaggedCloud(bytes)
        } catch (error) {
            console.warn("[dim-controller] an unreadable map cloud", error)
            return null
        }
    }

    #publish(stampMs: number | null, arrivedAt: number) {
        this.#note()
        this.onMap(this.map, stampMs, arrivedAt)
    }

    #note() {
        lastMapDiff = { ...this.#counts, voxels: this.map.size, removedTotal: this.map.removedTotal, premap: this.map.premapCount() }
    }

    #count(bytes: Uint8Array) {
        this.#sampled.messages++
        this.#sampled.bytes += bytes.byteLength
    }

    /** messages and bytes a second since the last call, and the map's points */
    sample(now = performance.now()) {
        const seconds = Math.max(1e-3, (now - this.#sampled.since) / 1000)
        const rate = { hz: this.#sampled.messages / seconds, pointsPerSecond: this.map.size, bytesPerSecond: this.#sampled.bytes / seconds }
        this.#sampled = { messages: 0, bytes: 0, since: now }
        return rate
    }

    #stopAsking() {
        if (this.#asking !== null) {
            clearInterval(this.#asking)
            this.#asking = null
        }
    }

    close() {
        feeds.delete(this)
        this.#stopAsking()
        this.#stops.forEach((stop) => stop())
    }
}
