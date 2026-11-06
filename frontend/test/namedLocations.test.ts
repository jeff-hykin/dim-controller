// dimos's named locations wire contract (dimos/mapping/relocalization/module.py): its list read as labels and a
// revision, and the whole lists (edited from that revision), request and goal the page sends.
import { assertEquals } from "jsr:@std/assert@1"
import { decode } from "../src/core/lcm/lcm.ts"
import { GOAL_KEY, listBytes, NamedLocations, type NamedPose, POINT_STAMPED, readList, renamedLocation, replaces, REQUEST_KEY, SNAPSHOT_KEY, stringBytes, UPDATE_TYPE, withLocation, withoutLocation } from "../src/core/namedLocations.ts"
import { Store } from "../src/core/store.ts"
import type { Connection } from "../src/core/transport.ts"

// dimos's own encoding of a snapshot: InteractiveMarkerUpdate([named_pose("kitchen", PoseStamped(ts=1700000000.5,
// frame_id="map", position=[1, 2, 0], orientation=[0, 0, 0.7071067811865476, 0.7071067811865476])), named_pose("dock",
// PoseStamped(ts=1700000001.0, frame_id="map", position=[-3.5, 0.25, 0.1]))], server_id="NamedLocations", seq_num=7).lcm_encode()
const DIMOS_SNAPSHOT = "e498190e0276d93d0000000000000002000000000000000f4e616d65644c6f636174696f6e7300000000000000000701000000016553f1001dcd6500000000046d6170003ff000000000000040000000000000000000000000000000000000000000000000000000000000003fe6a09e667f3bcd3fe6a09e667f3bcd000000086b69746368656e00000000016553f10100000000000000046d617000c00c0000000000003fd00000000000003fb999999999999a0000000000000000000000000000000000000000000000003ff000000000000000000005646f636b00"
const hex = (text: string) => new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

const at = (label: string, x: number, frame_id = "map"): NamedPose => ({ label, frame_id, position: [x, 0, 0], orientation: [0, 0, 0, 1] })
const rev = (seq_num: number, server_id = "run1") => ({ server_id, seq_num })
const names = (list: NamedPose[]) => list.map((one) => [one.label, one.position[0]])

/** A connection whose puts are recorded and whose /named_locations subscription the test feeds. */
function fakeConnection() {
    const sent: { key: string; bytes: Uint8Array }[] = []
    const status = new Store({ state: "connecting" })
    let deliver: (message: { bytes: Uint8Array }) => void = () => {}
    const client = { state: "connected", put: (key: string, bytes: Uint8Array) => (sent.push({ key, bytes }), Promise.resolve()) }
    const connection = {
        client,
        status,
        command: () => {},
        subscribe: (_key: string, _options: unknown, onMessage: typeof deliver) => {
            deliver = onMessage
            return Object.assign(() => {}, { ready: () => Promise.resolve() })
        },
    } as unknown as Connection
    return { connection, sent, status, deliver: (bytes: Uint8Array) => deliver({ bytes }) }
}

Deno.test("the module's topics", () => {
    assertEquals(SNAPSHOT_KEY, "dimos/named_locations/visualization_msgs.InteractiveMarkerUpdate")
    assertEquals(REQUEST_KEY, "dimos/named_locations_request/std_msgs.String")
    assertEquals(GOAL_KEY, "dimos/goal/geometry_msgs.PointStamped")
})

Deno.test("a dimos list reads as its revision and labels keyed by name, in map", () => {
    const { revision, locations: labels } = readList(hex(DIMOS_SNAPSHOT))
    assertEquals(revision, { server_id: "NamedLocations", seq_num: 7 })
    assertEquals(labels.map((label) => [label.id, label.label, label.frame_id]), [["kitchen", "kitchen", "map"], ["dock", "dock", "map"]])
    assertEquals(labels[0].position, [1, 2, 0])
    assertEquals(labels[0].orientation, [0, 0, 0.7071067811865476, 0.7071067811865476])
    assertEquals(labels[1].position, [-3.5, 0.25, 0.1])
    assertEquals(labels[0].created, 1_700_000_000.5e9)
})

Deno.test("an empty list is an empty list (the module is there)", () => {
    assertEquals(readList(listBytes([], rev(0))).locations, [])
})

Deno.test("a published list is the whole list, poses only, stamped, carrying the revision it was edited from", () => {
    const bytes = listBytes([at("galley", 1), at("dock", 2)], rev(4, "abc"), 1_700_000_123_456)
    assertEquals(Array.from(bytes.slice(0, 8)), Array.from(hex(DIMOS_SNAPSHOT).slice(0, 8)), "dimos's fingerprint")
    const update = decode(UPDATE_TYPE, bytes)
    assertEquals([update.erases, update.markers], [[], []])
    assertEquals([update.server_id, Number(update.seq_num)], ["abc", 4])
    // deno-lint-ignore no-explicit-any
    assertEquals(update.poses.map((pose: any) => [pose.name, pose.header.frame_id, pose.pose.position.x]), [["galley", "map", 1], ["dock", "map", 2]])
    assertEquals(update.poses[0].header.stamp, { sec: 1_700_000_123, nsec: 456_000_000 })
    assertEquals(update.poses[0].pose.orientation, { x: 0, y: 0, z: 0, w: 1 })
})

Deno.test("add, move, rename and delete are new whole lists, in order", () => {
    const list = [at("kitchen", 1), at("dock", 2)]
    assertEquals(names(withLocation(list, at("hall", 3))), [["kitchen", 1], ["dock", 2], ["hall", 3]])
    assertEquals(names(withLocation(list, at("kitchen", 5))), [["kitchen", 5], ["dock", 2]])
    assertEquals(names(renamedLocation(list, "kitchen", "galley")), [["galley", 1], ["dock", 2]])
    assertEquals(names(withoutLocation(list, "dock")), [["kitchen", 1]])
})

Deno.test("edits carry the cached list's revision, and the page draws the latest list heard", async () => {
    const fake = fakeConnection()
    const named = new NamedLocations(fake.connection)
    assertEquals(named.state.get().locations, null, "no module yet")
    fake.deliver(listBytes([at("kitchen", 1, "premap")], rev(3)))
    assertEquals(named.frame, "premap", "the list's frame, not a hardcoded map")
    await named.publish(renamedLocation(named.current, "kitchen", "galley"))
    assertEquals(named.current.map((one) => one.label), ["kitchen"], "drawn only once it comes back on the topic")
    assertEquals(fake.sent.map((one) => one.key), [SNAPSHOT_KEY])
    assertEquals(readList(fake.sent[0].bytes).revision, rev(3), "edited from revision 3, not dim-controller")
    fake.deliver(listBytes([at("galley", 1, "premap")], rev(4)))
    assertEquals(named.current.map((one) => one.label), ["galley"])
    fake.deliver(fake.sent[0].bytes)
    assertEquals([named.current.map((one) => one.label), named.state.get().revision], [["galley"], rev(4)], "a late echo of the old edit doesn't win")
    await named.goTo("galley")
    const goal = decode(POINT_STAMPED, fake.sent[1].bytes)
    assertEquals([fake.sent[1].key, goal.header.frame_id, goal.point], [GOAL_KEY, "premap", { x: 1, y: 0, z: 0 }])
})

Deno.test("a list replaces the cache unless it's an older revision of the same run", () => {
    assertEquals(replaces(null, rev(0)), true)
    assertEquals(replaces(rev(3), rev(3)), true)
    assertEquals(replaces(rev(3), rev(4)), true)
    assertEquals(replaces(rev(3), rev(2)), false)
    assertEquals(replaces(rev(3), rev(0, "run2")), true, "a restarted module")
})

Deno.test("no edit before a list came", async () => {
    const named = new NamedLocations(fakeConnection().connection)
    let failed = false
    await named.publish([at("hall", 1)]).catch(() => (failed = true))
    assertEquals(failed, true)
})

Deno.test("each connect asks for the list", async () => {
    const fake = fakeConnection()
    new NamedLocations(fake.connection)
    fake.status.set({ state: "connected" })
    fake.status.set({ state: "lost" })
    fake.status.set({ state: "connected" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(fake.sent.map((one) => one.key), [REQUEST_KEY, REQUEST_KEY])
})

Deno.test("strings are std_msgs.String", () => {
    assertEquals(decode("std_msgs.String", stringBytes("kitchen")).data, "kitchen")
})
