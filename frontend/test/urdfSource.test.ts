// UrdfSource (core/urdfSource.ts): "*.urdf" on /render_file_request asks for the URDF, on subscribing and on every connect,
// re-sent until it comes on /file_info (the first can beat the subscription), and an empty reply isn't a URDF.
import { assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "npm:@xmldom/xmldom@0.8.10"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { FILE_INFO, fileRanks, FILE_REQUEST, UrdfSource } from "../src/core/urdfSource.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser

const URDF = `<?xml version="1.0"?><robot name="box"><link name="base_link"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>`

/** a files.MeshFile on /file_info: the 8-byte timestamp, the name's length, the name, the bytes */
function fileInfo(uri: string, data: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode(uri)
    const bytes = new Uint8Array(12 + name.length + data.length)
    new DataView(bytes.buffer).setUint32(8, name.length, true)
    bytes.set(name, 12)
    bytes.set(data, 12 + name.length)
    return bytes
}

function fakeConnection(state: ConnectionState["state"] = "connected") {
    const requests: string[] = []
    /** what went to the older dimos's /file_request */
    const legacyRequests: string[] = []
    const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
    const client = {
        publisher(key: string) {
            const sent = key === FILE_REQUEST ? requests : legacyRequests
            assertEquals([FILE_REQUEST, "dimos/file_request/std_msgs.String"].includes(key), true, key)
            return { put: (bytes: Uint8Array) => sent.push(String(decode("std_msgs.String", bytes).data)), close() {} }
        },
    }
    const status = new Store({ state } as ConnectionState)
    const connection = {
        client: state === "connected" ? client : null,
        status,
        subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
            handlers.set(key, onMessage)
            return () => handlers.delete(key)
        },
    }
    const urdf = (xml: string) => handlers.get(FILE_INFO)!({ bytes: fileInfo("*.urdf", new TextEncoder().encode(xml)) })
    const connect = (to: ConnectionState["state"]) => {
        connection.client = client
        status.update({ state: to })
    }
    const robotDescription = (xml: string) => handlers.get("dimos/robot_description/std_msgs.String")!({ bytes: encode("std_msgs.String", { data: xml }) })
    return { connection: connection as unknown as Connection, requests, legacyRequests, urdf, robotDescription, connect }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("subscribing asks for the URDF at once, again until it comes, then not", async () => {
    const { connection, requests, urdf } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    assertEquals(requests, ["*.urdf"], "asked as it subscribes")
    await wait(600)
    assertEquals(requests.length >= 2, true, "asked again while none came")
    urdf(URDF)
    assertEquals(source.state.get().description?.name, "box")
    const asked = requests.length
    await wait(600)
    assertEquals(requests.length, asked, "no more once it came")
    assertEquals(requests.every((request) => request === "*.urdf"), true, "no mesh asked for: a box has none")
    release()
})

Deno.test("every connect asks again; a link that only dipped (degraded) doesn't", async () => {
    const { connection, requests, urdf, connect } = fakeConnection("connecting")
    const source = new UrdfSource(connection)
    const release = source.acquire()
    assertEquals(requests, [], "no client yet")
    connect("connected")
    assertEquals(requests, ["*.urdf"])
    urdf(URDF)
    connect("degraded")
    connect("connected")
    assertEquals(requests, ["*.urdf"])
    connect("lost")
    connect("connected")
    assertEquals(requests, ["*.urdf", "*.urdf"], "a reconnect asks again")
    urdf(URDF)
    release()
    connect("lost")
    connect("connected")
    assertEquals(requests, ["*.urdf", "*.urdf"], "not once nothing uses it")
    await wait(300)
})

Deno.test("an empty URDF isn't a URDF: what's loaded stays", () => {
    const { connection, urdf } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    urdf(URDF)
    urdf("")
    assertEquals(source.state.get().description?.name, "box")
    assertEquals(source.state.get().problem, null)
    release()
})

Deno.test("the robot's meshes are asked for first: a scene fixed to the root after, its splats last", async () => {
    const { connection, requests, urdf } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    const mesh = (name: string) => `<visual><geometry><mesh filename="package://p/${name}?hash=1"/></geometry></visual>`
    urdf(`<?xml version="1.0"?><robot name="r">
        <link name="world"/>
        <link name="scene_splats">${mesh("splats.spz")}</link>
        <link name="scene_mesh">${mesh("tile_0.stl")}${mesh("tile_1.stl")}</link>
        <link name="base_link">${mesh("body.stl")}</link>
        <link name="leg">${mesh("leg.stl")}</link>
        <joint name="a" type="fixed"><parent link="world"/><child link="scene_splats"/></joint>
        <joint name="b" type="fixed"><parent link="world"/><child link="scene_mesh"/></joint>
        <joint name="c" type="floating"><parent link="world"/><child link="base_link"/></joint>
        <joint name="d" type="revolute"><parent link="base_link"/><child link="leg"/><axis xyz="0 0 1"/></joint>
    </robot>`)
    // no IndexedDB here: every lookup comes back empty, then the first two are asked for
    await wait(50)
    assertEquals(requests.filter((request) => request !== "*.urdf"), ["package://p/body.stl?hash=1", "package://p/leg.stl?hash=1"])
    const ranks = fileRanks(source.state.get().description!)
    assertEquals(Object.fromEntries([...ranks].map(([uri, rank]) => [uri.split("/").pop(), rank])), { "splats.spz?hash=1": 2, "tile_0.stl?hash=1": 1, "tile_1.stl?hash=1": 1, "body.stl?hash=1": 0, "leg.stl?hash=1": 0 })
    release()
})

Deno.test("a dimos without /render_file_request: an empty /file_request asks, /robot_description answers", async () => {
    const { connection, legacyRequests, robotDescription } = fakeConnection()
    const source = new UrdfSource(connection)
    const release = source.acquire()
    assertEquals(legacyRequests, [""], "asked the older way too")
    robotDescription(URDF)
    assertEquals(source.state.get().description?.name, "box")
    const asked = legacyRequests.length
    await wait(600)
    assertEquals(legacyRequests.length, asked, "no more once it came")
    release()
})
