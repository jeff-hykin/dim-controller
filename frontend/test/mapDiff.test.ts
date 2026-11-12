// A global map kept from diffs (core/mapDiff.ts): a keyframe and the map_update diffs after it, applied in order, are the
// map; a diff older than the keyframe or before any keyframe changes nothing; the feed asks for a keyframe on
// cloud_keyframe_request until one comes, and again on a reconnect.
import { assertEquals } from "jsr:@std/assert@1"
import { encode } from "../src/core/lcm/lcm.ts"
import { DiffMap, diffTopicOf, MapDiffFeed, readFlaggedCloud } from "../src/core/mapDiff.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, Topic } from "../src/core/transport.ts"

/** A ray tracer's cloud: x, y, z, intensity, then each flag as a u8, as its points_to_cloud packs it. */
function cloudBytes(points: number[][], flags: string[], stampSec: number): Uint8Array {
    const step = 16 + flags.length
    const data = new Uint8Array(points.length * step)
    const view = new DataView(data.buffer)
    points.forEach((point, index) => {
        point.slice(0, 3).forEach((value, axis) => view.setFloat32(index * step + axis * 4, value, true))
        flags.forEach((_, flag) => (data[index * step + 16 + flag] = point[3 + flag]))
    })
    const field = (name: string, offset: number, datatype: number) => ({ name, offset, datatype, count: 1 })
    return encode("sensor_msgs.PointCloud2", {
        header: { seq: 0, stamp: { sec: stampSec, nsec: 0 }, frame_id: "world" },
        height: 1,
        width: points.length,
        fields_length: 4 + flags.length,
        fields: [field("x", 0, 7), field("y", 4, 7), field("z", 8, 7), field("intensity", 12, 7), ...flags.map((name, flag) => field(name, 16 + flag, 2))],
        is_bigendian: false,
        point_step: step,
        row_step: step * points.length,
        data_length: data.length,
        data,
        is_dense: true,
    })
}

const keyframe = (points: number[][], stampSec: number) => readFlaggedCloud(cloudBytes(points, ["premap"], stampSec))
const diff = (points: number[][], stampSec: number) => readFlaggedCloud(cloudBytes(points, ["premap", "change"], stampSec))
function sorted(map: DiffMap): number[][] {
    const p = map.positions()
    return Array.from({ length: p.length / 3 }, (_, index) => [p[index * 3], p[index * 3 + 1], p[index * 3 + 2]]).sort((a, b) => a[0] - b[0])
}

Deno.test("a keyframe and the diffs after it are the map, premap flags and removals included", () => {
    const map = new DiffMap()
    assertEquals(map.applyDiff(diff([[0.5, 0.5, 0.5, 0, 1]], 10)), false, "nothing to apply a diff to before a keyframe")
    map.applyKeyframe(keyframe([[6.5, 0.5, 0.5, 1], [0.5, 6.5, 0.5, 1]], 10))
    assertEquals([map.size, map.premapCount()], [2, 2])
    assertEquals(map.applyDiff(diff([[3.5, 0.5, 0.5, 0, 1]], 11)), true)
    // 3 cleared, 5 hit, and a live hit on the premap voxel up y makes it live
    map.applyDiff(diff([[5.5, 0.5, 0.5, 0, 1], [3.5, 0.5, 0.5, 0, 0], [0.5, 6.5, 0.5, 0, 1]], 12))
    assertEquals(sorted(map), [[0.5, 6.5, 0.5], [5.5, 0.5, 0.5], [6.5, 0.5, 0.5]])
    assertEquals([map.premapCount(), map.removedTotal], [1, 1])
    assertEquals(map.applyDiff(diff([[6.5, 0.5, 0.5, 1, 0]], 9)), false, "a diff older than the keyframe is already in it")
    assertEquals(map.size, 3)
})

Deno.test("a global map with a map_update beside it is kept from diffs", () => {
    const global: Topic = { key: "dimos/robot/global_map/sensor_msgs.PointCloud2", name: "/robot/global_map", type: "sensor_msgs.PointCloud2" }
    const update: Topic = { key: "dimos/robot/map_update/sensor_msgs.PointCloud2", name: "/robot/map_update", type: "sensor_msgs.PointCloud2" }
    const other: Topic = { key: "dimos/map_update/sensor_msgs.PointCloud2", name: "/map_update", type: "sensor_msgs.PointCloud2" }
    assertEquals(diffTopicOf(global, [other]), null)
    assertEquals(diffTopicOf(global, [other, update]), update)
})

Deno.test("the feed asks for a keyframe until one comes, and again on a reconnect", async () => {
    const puts: string[] = []
    const deliver = new Map<string, (message: unknown) => void>()
    const status = new Store<{ state: string }>({ state: "connected" })
    const connection = {
        status,
        client: { publisher: (key: string) => ({ put: () => puts.push(key) }) },
        subscribe(key: string, _options: unknown, onMessage: (message: unknown) => void) {
            deliver.set(key, onMessage)
            return () => deliver.delete(key)
        },
    } as unknown as Connection
    const global: Topic = { key: "dimos/global_map/sensor_msgs.PointCloud2", name: "/global_map", type: "sensor_msgs.PointCloud2" }
    const update: Topic = { key: "dimos/map_update/sensor_msgs.PointCloud2", name: "/map_update", type: "sensor_msgs.PointCloud2" }
    const shown: number[] = []
    const feed = new MapDiffFeed(connection, global, update, (map) => shown.push(map.size))
    assertEquals(puts, ["dimos/cloud_keyframe_request/std_msgs.Bool"])

    deliver.get(update.key)!({ bytes: cloudBytes([[1.5, 0.5, 0.5, 0, 1]], ["premap", "change"], 5), timestamp: 0 })
    assertEquals(shown, [], "a diff before the keyframe is dropped")
    deliver.get(global.key)!({ bytes: cloudBytes([[0.5, 0.5, 0.5, 1]], ["premap"], 5), timestamp: 0 })
    deliver.get(update.key)!({ bytes: cloudBytes([[1.5, 0.5, 0.5, 0, 1]], ["premap", "change"], 6), timestamp: 0 })
    assertEquals(shown, [1, 2])

    await new Promise((resolve) => setTimeout(resolve, 2100))
    assertEquals(puts.length, 1, "no more asking once the keyframe came")
    status.set({ state: "lost" })
    status.set({ state: "connected" })
    assertEquals(puts.length, 2, "a reconnect asks again")
    feed.close()
    assertEquals(deliver.size, 0)
})
