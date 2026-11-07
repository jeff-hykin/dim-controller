// A sim's world the UrdfManager way, one per page: "sim_scene.json" asked for on /render_file_request (on subscribing,
// on every connect, every few seconds until it comes, then now and then to catch a reset sim) comes on /file_info as a
// dimos.scene_data.v2 index, which names a file for each mesh (STL) and texture (PNG), each asked for the same way. A
// changed index `id` is a new scene. The layer manager shows the sim-scene layer once an index has come.
import type * as THREE from "three"
import { encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeMeshFile, meshGeometry } from "dimos-react/three"
import { FILE_INFO, FILE_REQUEST } from "./urdfSource.ts"
import { type SceneData, type SceneFiles, sceneFileNames } from "./sceneData.ts"
import { UNWRAPPED } from "./freeze.ts"

/** an older sim's "I'm here" (its scene's id); the sim-scene layer is listed under it for either kind of sim */
export const SCENE_INFO = dimosKey("/scene_info", "std_msgs.String")
/** the v2 scene's index, as asked for on /render_file_request */
export const SCENE_FILE = "sim_scene.json"
/** the index is asked for this often until it comes (the sim may start after the page) */
const ASK_UNTIL_ANSWERED_MS = 2000
/** ...and this often once it has, so a sim that restarted with another scene is noticed */
const ASK_AFTER_MS = 10000
/** files asked for at once, as the robot model's meshes (urdfSource.ts) */
const FILES_IN_FLIGHT = 2
/** a file asked for this long ago without a reply is asked for again */
const FILE_RETRY_MS = 60000

export interface SimSceneState {
    data: SceneData | null
    /** bumped as each of its files is loaded */
    filesVersion: number
    problem: string | null
}

/** a PNG's pixels as RGBA, rows top first (as the sim wrote them) */
async function pngPixels(data: Uint8Array): Promise<Uint8Array> {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" })
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext("2d")!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer)
}

export class SimSceneSource {
    readonly state = new Store<SimSceneState>({ data: null, filesVersion: 0, problem: null })
    /** the scene's loaded files (replaced when the scene changes) */
    files: SceneFiles = { geometries: new Map(), pixels: new Map() }
    #users = 0
    #stops: (() => void)[] = []
    #requests: Publisher | null = null
    #timer: ReturnType<typeof setInterval> | null = null
    #askedIndexAt = 0
    /** file name -> when it was last asked for (-1: decoding) */
    #asked = new Map<string, number>()
    #failed = new Set<string>()

    constructor(readonly connection: Connection) {}

    /** Starts listening (first user); the returned function lets go (the last one stops it, keeping what's loaded). */
    acquire(): () => void {
        if (this.#users++ === 0) {
            this.#stops.push(this.connection.subscribe(FILE_INFO, { delivery: "reliable", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onFile(message.bytes)))
            let state = this.connection.status.get().state
            this.#stops.push(this.connection.status.subscribe(() => {
                const now = this.connection.status.get().state
                if (now === "connected" && state !== "connected" && state !== "degraded") {
                    this.#askForIndex()
                }
                state = now
            }))
            this.#timer = setInterval(() => this.#tick(), 1000)
            this.#askForIndex()
        }
        let released = false
        return () => {
            if (released) {
                return
            }
            released = true
            if (--this.#users === 0) {
                this.#stops.splice(0).forEach((stop) => stop())
                clearInterval(this.#timer!)
                this.#requests?.close()
                this.#requests = null
                this.#asked.clear()
            }
        }
    }

    #tick() {
        if (Date.now() - this.#askedIndexAt >= (this.state.get().data ? ASK_AFTER_MS : ASK_UNTIL_ANSWERED_MS)) {
            this.#askForIndex()
        }
        this.#askForFiles()
    }

    #put(name: string): boolean {
        const client = this.connection.client
        if (!client) {
            return false
        }
        this.#requests ??= client.publisher(FILE_REQUEST, { delivery: "reliable" })
        try {
            this.#requests.put(encode("std_msgs.String", { data: name }))
            return true
        } catch {
            // not open yet: the next tick asks
            return false
        }
    }

    #askForIndex() {
        this.#askedIndexAt = Date.now()
        this.#put(SCENE_FILE)
    }

    #onFile(bytes: Uint8Array) {
        let file: ReturnType<typeof decodeMeshFile>
        try {
            file = decodeMeshFile(bytes)
        } catch {
            // the robot model's source says what's wrong with /file_info
            return
        }
        if (file.uri === SCENE_FILE) {
            this.#onIndex(file.data)
            return
        }
        const data = this.state.get().data
        // another's file (the robot's meshes), or one already here
        if (!data || !sceneFileNames(data).includes(file.uri) || this.#asked.get(file.uri) === -1 || this.#has(file.uri)) {
            return
        }
        this.#asked.set(file.uri, -1)
        this.#load(data, file.uri, file.data)
        this.#askForFiles()
    }

    #onIndex(bytes: Uint8Array) {
        let data: SceneData
        try {
            data = JSON.parse(new TextDecoder().decode(bytes)) as SceneData
        } catch (error) {
            this.state.update({ problem: `${SCENE_FILE} isn't JSON: ${error}` })
            return
        }
        if (data.format !== "dimos.scene_data.v2" || data.id === this.state.get().data?.id) {
            return
        }
        this.files = { geometries: new Map(), pixels: new Map() }
        this.#asked.clear()
        this.#failed.clear()
        this.state.update({ data, filesVersion: 0, problem: null })
        this.#askForFiles()
    }

    #has = (name: string) => this.files.geometries.has(name) || this.files.pixels.has(name)

    async #load(data: SceneData, name: string, bytes: Uint8Array) {
        const files = this.files
        try {
            if (name.endsWith(".png")) {
                files.pixels.set(name, await pngPixels(bytes))
            } else {
                files.geometries.set(name, meshGeometry(name, bytes) as THREE.BufferGeometry)
            }
            if (this.state.get().data === data) {
                this.state.update({ filesVersion: this.state.get().filesVersion + 1 })
            }
        } catch (error) {
            this.#failed.add(name)
            this.state.update({ problem: `${name}: ${error}` })
        } finally {
            if (this.#asked.get(name) === -1) {
                this.#asked.delete(name)
            }
        }
    }

    #askForFiles() {
        const data = this.state.get().data
        if (!data) {
            return
        }
        const now = Date.now()
        for (const [name, at] of this.#asked) {
            if (at !== -1 && now - at > FILE_RETRY_MS) {
                this.#asked.delete(name)
            }
        }
        const missing = sceneFileNames(data).filter((name) => !this.#has(name) && !this.#failed.has(name) && !this.#asked.has(name))
        for (const name of missing.slice(0, Math.max(0, FILES_IN_FLIGHT - this.#asked.size))) {
            if (!this.#put(name)) {
                return
            }
            this.#asked.set(name, now)
        }
    }

    /** files of the scene loaded / named */
    progress(): { loaded: number; wanted: number } {
        const names = this.state.get().data ? sceneFileNames(this.state.get().data!) : []
        return { loaded: names.filter(this.#has).length, wanted: names.length }
    }
}

const sources = new WeakMap<Connection, SimSceneSource>()

/** The page's one SimSceneSource for its connection (a layer's gated one included). */
export function simSceneSource(wrapped: Connection): SimSceneSource {
    const connection = (wrapped as Connection & { [UNWRAPPED]?: Connection })[UNWRAPPED] ?? wrapped
    let source = sources.get(connection)
    if (!source) {
        source = new SimSceneSource(connection)
        sources.set(connection, source)
    }
    return source
}
