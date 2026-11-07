// UrdfSource with a USD robot (core/usd.ts, core/urdfSource.ts): `*.usd` asked for beside `*.urdf` when this build has
// a USD parser and not when it hasn't, a `.usda` reply read as the description, and its meshes asked for by the plain
// path the layer names (never with `&have=`, which only a `?hash=` name can carry) and cached under the content hash
// the layer carries in `assetInfo`, so a second load asks for nothing. A layer whose assets have no hash is fetched
// every load instead of failing.
//
// The parser itself is dimos-react's and has its own tests there; the stand-in below is only enough of one to drive
// this app's half, and is what a build whose pinned dimos-react predates the parser has in place of it. The layer is a
// real one: fixtures/little_arm.usda is what dimos's urdf_to_usd wrote, hash and all, and the STL here is the file
// that hash is of.
import { assertEquals } from "jsr:@std/assert@1"
import { DOMParser } from "npm:@xmldom/xmldom@0.8.10"
import { IDBFactory } from "npm:fake-indexeddb@6.0.0"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { resetCacheConnection } from "../src/core/meshCache.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import { FILE_INFO, FILE_REQUEST, UrdfSource } from "../src/core/urdfSource.ts"
import { installUsdParser, isUsdName, type UsdParser } from "../src/core/usd.ts"
import type { RobotDescription } from "../src/core/robotDescription.ts"

;(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser
const global = globalThis as { indexedDB?: IDBFactory }
const LAYER = Deno.readTextFileSync(new URL("./fixtures/little_arm.usda", import.meta.url))
/** the one asset fixtures/little_arm.usda names, and the hash it names it by */
const MESH = "/tmp/dim-controller-usd-fixture/meshes/arm.stl"
const HASH = "sha256:f58fac8359d3cd2936682d4730f955acd5f899a224d343337d7acdb3f3e124a6"

/** a binary STL of one triangle: the file fixtures/little_arm.usda's hash is of */
function stl(): Uint8Array {
    const bytes = new Uint8Array(84 + 50)
    const view = new DataView(bytes.buffer)
    view.setUint32(80, 1, true)
    ;[0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(84 + index * 4, value, true))
    return bytes
}

/** files.File's wire form: `<f64 ts><u32 name length><name><file bytes>` */
function fileInfo(uri: string, data: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode(uri)
    const bytes = new Uint8Array(12 + name.length + data.length)
    new DataView(bytes.buffer).setUint32(8, name.length, true)
    bytes.set(name, 12)
    bytes.set(data, 12 + name.length)
    return bytes
}

/**
 * Enough of dimos-react's USD parser to drive this app: the layer's meshes and their assetInfo hashes, and a
 * description with one link per mesh. Deliberately not a USD reader — that is dimos-react's, tested there.
 */
function standIn(hashes = true): UsdParser {
    const meshesOf = (text: string) => [...text.matchAll(/prepend references = @([^@]+)@/g)].map((match) => match[1])
    return {
        isUsda: (text) => /^\s*#usda\s/.test(text),
        usdaMeshUris: meshesOf,
        usdaAssetHashes: (text) => {
            const found = new Map<string, string>()
            if (!hashes) {
                return found
            }
            for (const [, path, version] of text.matchAll(/asset identifier = @([^@]+)@\s*\n\s*string version = "([^"]+)"/g)) {
                found.set(path, version)
            }
            return found
        },
        parseUsda(text): RobotDescription {
            if (!this.isUsda(text)) {
                throw new Error("not a USD layer")
            }
            const origin = { xyz: [0, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] }
            return {
                name: "little_arm",
                base_link: "base_link",
                base_frame: "base_link",
                base_pose: origin,
                joint_names: [],
                joints: [],
                links: [{ name: "base_link", visuals: meshesOf(text).map((mesh) => ({ type: "mesh" as const, origin, mesh })), collisions: [] }],
            }
        },
    }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const quietly = async (run: () => Promise<void>) => {
    const info = console.info
    console.info = () => {}
    try {
        await run()
    } finally {
        console.info = info
    }
}

/** a fresh, empty IndexedDB and a USD parser in place for one test, both put back after it */
async function withUsd(parser: UsdParser | null, run: () => Promise<void>) {
    const factory = new IDBFactory()
    global.indexedDB = factory
    resetCacheConnection()
    const previous = installUsdParser(parser)
    try {
        await quietly(run)
    } finally {
        await wait(50)
        delete global.indexedDB
        resetCacheConnection()
        installUsdParser(previous)
    }
}

/** a page load: a UrdfSource on a fake connection, the layer sent as the reply to `*.usd`, each asset served once */
async function load({ served = true } = {}) {
    const requests: string[] = []
    const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
    const connection = {
        client: {
            publisher: (key: string) => ({
                put(bytes: Uint8Array) {
                    const asked = String(decode("std_msgs.String", bytes).data)
                    if (key !== FILE_REQUEST) {
                        // the older dimos's /file_request, asked with an empty name until a description comes
                        return
                    }
                    requests.push(asked)
                    if (asked === "*.usd") {
                        setTimeout(() => handlers.get(FILE_INFO)?.({ bytes: fileInfo("*.usd", new TextEncoder().encode(LAYER)) }))
                    } else if (asked === MESH && served) {
                        const reply = fileInfo(MESH, stl())
                        setTimeout(() => handlers.get(FILE_INFO)?.({ bytes: reply }))
                    }
                },
                close() {},
            }),
        },
        status: new Store({ state: "connected" } as ConnectionState),
        subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
            handlers.set(key, onMessage)
            return () => handlers.delete(key)
        },
    } as unknown as Connection
    const source = new UrdfSource(connection)
    const release = source.acquire()
    for (let tries = 0; tries < 100 && source.state.get().meshesLoaded < 1; tries++) {
        await wait(20)
    }
    const state = source.state.get()
    release()
    // the store's transaction commits
    await wait(50)
    return { requests: [...new Set(requests)], description: state.description, loaded: state.meshesLoaded, wanted: state.meshesWanted, problem: state.problem }
}

Deno.test("a name says whether a reply is a USD layer", () => {
    assertEquals([".usd", ".usda", "*.usd"].map((name) => isUsdName(`scene${name}`)), [true, true, true])
    assertEquals(isUsdName("scene.USDA"), true, "the name's case isn't the robot's to get right")
    assertEquals([isUsdName("robot.urdf"), isUsdName("a.stl"), isUsdName("x.usdc.gz")], [false, false, false])
})

Deno.test("a USD robot: the layer read, its mesh asked for by the plain path, drawn and cached under its assetInfo hash", async () => {
    await withUsd(standIn(), async () => {
        const first = await load()
        assertEquals(first.problem, null)
        assertEquals(first.description?.name, "little_arm", "the layer became the description")
        assertEquals([first.loaded, first.wanted], [1, 1])
        assertEquals(first.requests, ["*.urdf", "*.usd", MESH], "both names asked for, then the asset by the path the layer names")
        // a reload: the page's connection to the database is gone, the database isn't
        resetCacheConnection()
        const second = await load()
        assertEquals(second.loaded, 1, "drawn again")
        assertEquals(second.requests, ["*.urdf", "*.usd"], "the cached copy is used: nothing asked for the mesh")
    })
})

Deno.test("a layer whose assets carry no hash is fetched every load, not refused", async () => {
    await withUsd(standIn(false), async () => {
        const first = await load()
        assertEquals([first.loaded, first.problem], [1, null])
        resetCacheConnection()
        const second = await load()
        assertEquals(second.loaded, 1, "drawn, from the robot again")
        assertEquals(second.requests, ["*.urdf", "*.usd", MESH], "nothing to cache by, so it's asked for again")
    })
})

Deno.test("a blueprint answering both names: the first description is the one in use", async () => {
    await withUsd(standIn(), async () => {
        const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
        const connection = {
            client: { publisher: () => ({ put() {}, close() {} }) },
            status: new Store({ state: "connected" } as ConnectionState),
            subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
                handlers.set(key, onMessage)
                return () => handlers.delete(key)
            },
        } as unknown as Connection
        const source = new UrdfSource(connection)
        const release = source.acquire()
        const urdf = `<?xml version="1.0"?><robot name="box"><link name="base_link"/></robot>`
        handlers.get(FILE_INFO)!({ bytes: fileInfo("*.urdf", new TextEncoder().encode(urdf)) })
        assertEquals(source.state.get().description?.name, "box")
        handlers.get(FILE_INFO)!({ bytes: fileInfo("*.usd", new TextEncoder().encode(LAYER)) })
        assertEquals(source.state.get().description?.name, "box", "the layer that came second doesn't replace it")
        assertEquals(source.state.get().problem, null)
        release()
    })
})

Deno.test("a build with no USD parser asks only for the URDF, and ignores a layer that comes anyway", async () => {
    await withUsd(null, async () => {
        const requests: string[] = []
        const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
        const connection = {
            client: { publisher: () => ({ put: (bytes: Uint8Array) => requests.push(String(decode("std_msgs.String", bytes).data)), close() {} }) },
            status: new Store({ state: "connected" } as ConnectionState),
            subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
                handlers.set(key, onMessage)
                return () => handlers.delete(key)
            },
        } as unknown as Connection
        const source = new UrdfSource(connection)
        const release = source.acquire()
        assertEquals(requests, ["*.urdf", ""], "no *.usd: nothing could be done with the answer")
        handlers.get(FILE_INFO)!({ bytes: fileInfo("scene.usda", new TextEncoder().encode(LAYER)) })
        assertEquals(source.state.get().description, null, "the layer is ignored")
        assertEquals(source.state.get().problem, null, "and nothing is wrong with the page")
        release()
    })
})
