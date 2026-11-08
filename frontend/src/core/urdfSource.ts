// The robot's description and its meshes from dimos's UrdfManager or UsdManager, one per page, shared by the robot
// model layer and the arm view: the description asked for as `*.urdf` and `*.usd` on /render_file_request (on
// subscribing, on every connect, and every second until it comes) and each mesh asked for by the full path the
// description names; every reply comes on /file_info, a name ending in .urdf being a URDF and one ending in .usd or
// .usda a USD layer (whichever answers first wins; neither is waited for). Replies come in any order, possibly from
// more than one publisher. A dimos without UrdfManager's /render_file_request (dimos main for now) has
// /robot_description's XML (an empty /file_request has it sent now) and meshes asked for on /file_request: both are
// asked until a description comes, and its meshes go where it came from. Subscribed only while something uses it
// (acquire). Replies come unreliably (most recent): the description names every file, so one not loaded is asked for
// again every meshRetryMs (Settings → Advanced → Robot model) until it lands.
//
// Every file is kept in IndexedDB (core/meshCache.ts) and used with no request while its hash is the one the
// description names. What identifies it differs: a URDF names the file `path.stl?hash=<sha256>` (and an outdated copy
// is asked for as `&have=<the cached hash>`, which only that form can carry), a USD layer names the plain path and
// carries the hash beside it in standard `assetInfo` (core/usd.ts), which dimos will not serve a subtree without. A
// file the description identifies neither way is cached under the hash of the description's own text, so it is still
// cached but goes stale only when the description changes (dimos's UrdfManager dropped ?hash= on 10-23).
//
// Splat files (core/splats.ts) come the same way and are kept apart from the meshes.
import type * as THREE from "three"
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeMeshFile, meshGeometry, meshUris, parseUrdf } from "dimos-react/three"
import { cachedFile, meshLog, splitHash, storeFile } from "./meshCache.ts"
import { loadSplats, type SplatAsset, splatFileType, StaleBuildError } from "./splats.ts"
import { imageTexture, isImage } from "./imageTexture.ts"
import type { RobotDescription } from "./robotDescription.ts"
import { isUsdName, USD_REQUEST, usdAssetHashes, usdParser } from "./usd.ts"

export const FILE_REQUEST = dimosKey("/render_file_request", "std_msgs.String")
/** the older dimos's: the URDF on /robot_description, meshes asked for on /file_request */
export const ROBOT_DESCRIPTION = dimosKey("/robot_description", "std_msgs.String")
const LEGACY_FILE_REQUEST = dimosKey("/file_request", "std_msgs.String")
/** what a request for the URDF names: UrdfManager answers any *.urdf with its URDF, named as asked */
const URDF_REQUEST = "*.urdf"
/** /file_info and anything under it (/file_info/**): zenoh's `**` also matches no chunks */
export const FILE_INFO = dimosKey("/file_info/**", "files.File")
/** the same bytes under the older dimos's type name */
export const LEGACY_FILE_INFO = dimosKey("/file_info/**", "files.MeshFile")
/** files asked for at once: one reply can be several MB, so two at a time keep the link for driving and video (and a
 * burst of them loses some on the way, each then asked for again after meshRetryMs) */
const MESHES_IN_FLIGHT = 2
/** the default for how long a mesh asked for without a reply waits before it's asked for again (an 8 MB STL over a
 * 2 Mbit/s link takes ~30 s: on a link that slow, raise it in Settings or the big ones keep restarting) */
export const MESH_RETRY_MS = 10000
/** a splat file is tens of MB (a 1.2M-splat home's SPZ is ~27 MB, ~2 min at 2 Mbit/s): asking again sooner would send it twice */
const SPLAT_RETRY_MS = 600000
/** the URDF is asked for this often until it comes: the first can go out before the subscription is open */
const URDF_ASK_MS = 250
/** ...this fast for this long, then once a second (with the meshes) until a robot answers */
const URDF_ASK_FOR_MS = 5000

export interface UrdfState {
    description: RobotDescription | null
    /** meshes loaded / meshes the URDF uses */
    meshesLoaded: number
    meshesWanted: number
    /** bumped whenever a mesh arrives, for models filling in */
    meshVersion: number
    problem: string | null
    /** robot model layers drawing it now (the stand-in model hides meanwhile) */
    drawing: number
    /** the arm view draws the robot itself: the layer steps aside */
    armDraws: boolean
}

export class UrdfSource {
    readonly state = new Store<UrdfState>({ description: null, meshesLoaded: 0, meshesWanted: 0, meshVersion: 0, problem: null, drawing: 0, armDraws: false })
    /** loaded meshes by URI (as the URDF names them), shared by every model built from the description (never disposed by a model) */
    readonly geometries = new Map<string, THREE.BufferGeometry>()
    /** images a material named, decoded ready to be tiled over a shape */
    readonly textures = new Map<string, THREE.Texture>()
    /** loaded splat files by URI, likewise */
    readonly splats = new Map<string, SplatAsset>()
    /** the description's text as it came (URDF XML or a USD layer), so the same one isn't parsed twice */
    #text = ""
    /** a USD layer's `assetInfo` hashes: the file's path as the layer names it → "sha256:…" (empty for a URDF) */
    #assetHashes = new Map<string, string>()
    /** said once: a USD layer came that this build can't read */
    #saidNoUsd = false
    /** which kind of description is in use: the first that came, the other kind then being ignored */
    #kind: "URDF" | "USD" | null = null
    #users = 0
    #stops: (() => void)[] = []
    /** request publishers by key */
    #requests = new Map<string, Publisher>()
    /** where the URDF came from, so its meshes are asked for there (null: not yet, ask both) */
    #meshRequestKey: string | null = null
    /** URI → when it was last asked for */
    #asked = new Map<string, number>()
    /** URI → the hash of the copy in the cache that isn't current (sent as &have=) */
    #have = new Map<string, string>()
    /** sha256 of the description's text: the hash a file it identifies no other way is cached under */
    #descriptionHash = ""
    #failed = new Set<string>()
    /** URIs being decoded (a splat file decodes in a worker) */
    #decoding = new Set<string>()
    #timer: ReturnType<typeof setInterval> | null = null
    /** set once the cache has been looked at for this URDF's meshes (asking waits for that) */
    #cacheChecked = false
    /** the URDF's files in the order they're wanted (fileRanks) */
    #files: string[] = []
    /** for the console: when the URDF came (performance.now()), each file's rank, the ranks logged as drawn */
    #descriptionAt = 0
    #ranks = new Map<string, number>()
    #drawnRanks = new Set<number>()
    /** while asking for the URDF fast: the re-ask timer, and when asking slows to the 1 s tick */
    #descriptionAsk: { timer: ReturnType<typeof setInterval>; until: number } | null = null
    /** a mesh asked for this long ago without a reply is asked for again (Settings → Advanced → Robot model) */
    meshRetryMs = MESH_RETRY_MS

    constructor(readonly connection: Connection) {}

    /** Starts listening (first user); the returned function lets go (the last one stops it, keeping what's loaded). */
    acquire(): () => void {
        if (this.#users++ === 0) {
            // the model loads once, behind everything live
            this.#stops.push(this.connection.subscribe(ROBOT_DESCRIPTION, { delivery: "latest" }, (message) => this.#onRobotDescription(message.bytes)))
            for (const key of [FILE_INFO, LEGACY_FILE_INFO]) {
                this.#stops.push(this.connection.subscribe(key, { delivery: "latest", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onFile(message.bytes)))
            }
            this.#timer = setInterval(() => this.#askForMeshes(), 1000)
            let state = this.connection.status.get().state
            this.#stops.push(this.connection.status.subscribe(() => {
                const now = this.connection.status.get().state
                if (now === "connected" && state !== "connected" && state !== "degraded") {
                    this.#askForDescription()
                }
                state = now
            }))
            this.#askForDescription()
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
                this.#stopAskingForDescription()
                this.#requests.forEach((publisher) => publisher.close())
                this.#requests.clear()
                this.#asked.clear()
            }
        }
    }

    /** Asks for the description now, again every URDF_ASK_MS for URDF_ASK_FOR_MS (then the 1 s tick asks) until it comes. */
    #askForDescription() {
        this.#stopAskingForDescription()
        const ask = () => {
            if (Date.now() > this.#descriptionAsk!.until) {
                this.#stopAskingForDescription()
                return
            }
            this.#putDescriptionRequests()
        }
        this.#descriptionAsk = { timer: setInterval(ask, URDF_ASK_MS), until: Date.now() + URDF_ASK_FOR_MS }
        ask()
    }

    /** Both names at once: UrdfManager answers *.urdf, UsdManager *.usd, and whichever answers first is the robot's. */
    #putDescriptionRequests() {
        try {
            const requests = this.#publisher(FILE_REQUEST)
            requests?.put(encode("std_msgs.String", { data: URDF_REQUEST }))
            // nothing can be done with a layer this build can't read, so it isn't asked for
            if (usdParser()) {
                requests?.put(encode("std_msgs.String", { data: USD_REQUEST }))
            }
            this.#publisher(LEGACY_FILE_REQUEST)?.put(encode("std_msgs.String", { data: "" }))
        } catch {
            // not open yet: the next one goes
        }
    }

    #stopAskingForDescription() {
        clearInterval(this.#descriptionAsk?.timer)
        this.#descriptionAsk = null
    }

    #publisher(key: string): Publisher | null {
        const client = this.connection.client
        if (client && !this.#requests.has(key)) {
            this.#requests.set(key, client.publisher(key, { delivery: "reliable" }))
        }
        return this.#requests.get(key) ?? null
    }

    #onRobotDescription(bytes: Uint8Array) {
        try {
            this.#onDescription(String(decode("std_msgs.String", bytes).data ?? ""), LEGACY_FILE_REQUEST)
        } catch (error) {
            this.state.update({ problem: `/robot_description isn't a std_msgs.String: ${error}` })
        }
    }

    /**
     * A description that arrived, as a URDF or as a USD layer: the same RobotDescription either way, so only the
     * parsing and where the files' hashes come from differ. `name` is what the reply was called, which decides
     * nothing on its own — the layer's own `#usda` header does.
     */
    #onDescription(text: string, requestKey: string, name = "") {
        this.#stopAskingForDescription()
        // nothing yet (or an empty one) isn't a description
        if (text === this.#text || !text) {
            return
        }
        const usd = usdParser()
        const asUsd = usd ? usd.isUsda(text) : false
        if (!asUsd && isUsdName(name)) {
            // a layer this build can't read (another page asked for it, or its dimos-react predates the parser):
            // nothing is wrong with the page, the URDF request is still out, so this is one console line and no more
            if (!this.#saidNoUsd) {
                this.#saidNoUsd = true
                meshLog(usd ? `${name} came but has no #usda header: ignored` : `${name} came, but this build's dimos-react has no USD parser: ignored`)
            }
            return
        }
        const kind = asUsd ? "USD" : "URDF"
        if (this.#kind && this.#kind !== kind) {
            // a blueprint running both managers answers both names: the one that got here first is the robot's, and
            // swapping descriptions would throw away everything loaded for nothing (they describe the same robot)
            meshLog(`${kind} came after ${this.#kind}: ignored, the first description is the one in use`)
            return
        }
        try {
            const description = asUsd ? usd!.parseUsda(text) : parseUrdf(text)
            this.#text = text
            this.#kind = kind
            this.#assetHashes = asUsd ? usdAssetHashes(text, usd!) : new Map()
            this.#meshRequestKey = requestKey
            this.#asked.clear()
            this.#have.clear()
            this.#descriptionHash = ""
            this.#failed.clear()
            this.#cacheChecked = false
            const ranks = fileRanks(description)
            this.#files = meshUris(description).sort((a, b) => ranks.get(a)! - ranks.get(b)!)
            this.#descriptionAt = performance.now()
            this.#ranks = ranks
            this.#drawnRanks.clear()
            const named = this.#files.filter((uri) => splitHash(uri).hash).length
            const beside = this.#files.filter((uri) => !splitHash(uri).hash && this.#assetHashes.has(uri)).length
            meshLog(`${kind}: ${this.#files.length} files, ${named} hashed in their name, ${beside} in assetInfo, the rest cached under the ${kind}'s`)
            this.state.update({ description, meshesWanted: meshUris(description).length, problem: null })
            this.#count()
            this.#loadCached(description)
        } catch (error) {
            this.state.update({ problem: `the ${kind}: ${error}` })
        }
    }

    /**
     * What the description says this file's content is, for the cache: a URDF's `?hash=` in the name, or a USD
     * layer's `assetInfo` hash beside the plain path. One it identifies neither way falls back to the hash of the
     * description's own text, so it is cached too and goes stale only when the description changes. `base` is the
     * cache's key either way.
     */
    #hashOf(uri: string): { base: string; hash: string | null } {
        const { base, hash } = splitHash(uri)
        return { base, hash: hash ?? this.#assetHashes.get(uri) ?? (this.#descriptionHash || null) }
    }

    #loaded = (uri: string) => this.geometries.has(uri) || this.splats.has(uri) || this.textures.has(uri)

    #onFile(bytes: Uint8Array) {
        const description = this.state.get().description
        let file: ReturnType<typeof decodeMeshFile>
        try {
            file = decodeMeshFile(bytes)
        } catch (error) {
            this.state.update({ problem: `/file_info: ${error}` })
            return
        }
        if (file.uri.endsWith(".urdf") || isUsdName(file.uri)) {
            this.#onDescription(new TextDecoder().decode(file.data), FILE_REQUEST, file.uri)
            return
        }
        if (!description) {
            return
        }
        // the description's name for it: the same URL, its ?hash= possibly newer than the description's (the file
        // changed since). A USD layer names the plain path, so there its name and the reply's are the same string.
        const reply = splitHash(file.uri)
        const uri = meshUris(description).find((each) => each === file.uri || (reply.hash && splitHash(each).base === reply.base))
        // another page's reply, or one already loaded
        if (!uri || this.#loaded(uri) || this.#decoding.has(uri)) {
            return
        }
        this.#asked.delete(uri)
        meshLog(`got ${file.uri.split("/").pop()?.split("?")[0]} (${(file.data.byteLength / 1e6).toFixed(1)} MB) ${this.#since()}`)
        const known = this.#hashOf(uri)
        // the reply's own hash wins when it carries one: the file may have changed since the description was made
        if (known.hash) {
            this.#store(known.base, reply.hash ?? known.hash, file.data.slice())
        }
        this.#load(uri, file.data)
        this.#askForMeshes()
    }

    /**
     * Caches a file under the hash the description gave it, checking the bytes first when that hash says what it is
     * (`sha256:<hex>`, the form USD's assetInfo carries): a file that changed since the description was made would
     * otherwise be kept under the old file's hash and drawn from the cache for every later load. A URDF's bare
     * `?hash=` value doesn't say what it is of, so it's taken as given.
     */
    async #store(base: string, hash: string, data: Uint8Array) {
        const [algorithm, hex] = hash.split(":")
        if (algorithm === "sha256" && hex && globalThis.crypto?.subtle) {
            const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer)
            const got = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
            if (got !== hex) {
                meshLog(`${base.split("/").pop()} isn't what the description says it is (sha256 ${got.slice(0, 12)}…, not ${hex.slice(0, 12)}…): drawn, not cached`)
                return
            }
        }
        storeFile(base, hash, data)
    }

    /** Turns a file's bytes into a mesh or splats (splats decode off the main thread). */
    async #load(uri: string, data: Uint8Array): Promise<boolean> {
        const fileType = splatFileType(uri, data)
        this.#decoding.add(uri)
        const started = performance.now()
        try {
            if (fileType) {
                this.splats.set(uri, await loadSplats(data, fileType))
            } else if (isImage(uri)) {
                this.textures.set(uri, await imageTexture(data, uri))
            } else {
                this.geometries.set(uri, meshGeometry(uri, data))
            }
            meshLog(`decoded ${uri.split("/").pop()?.split("?")[0]} in ${Math.round(performance.now() - started)} ms, ${this.#since()}`)
        } catch (error) {
            this.#failed.add(uri)
            this.state.update({ problem: error instanceof StaleBuildError ? error.message : `${uri}: ${error}` })
            return false
        } finally {
            this.#decoding.delete(uri)
            this.#count()
        }
        return true
    }

    /** Looks every hashed file up in the cache at once, using each whose hash is the description's as soon as it's read
     * (the robot's first); the rest are asked for (an outdated copy's hash as &have=) once every lookup is done. */
    async #loadCached(description: RobotDescription) {
        const loads: Promise<unknown>[] = []
        const counts = { hit: 0, hitBytes: 0, stale: 0, missing: 0 }
        const descriptionHash = await textHash(this.#text)
        if (this.state.get().description !== description) {
            return
        }
        this.#descriptionHash = descriptionHash
        await Promise.all(this.#files.map(async (uri) => {
            const { base, hash } = this.#hashOf(uri)
            if (this.#loaded(uri)) {
                return
            }
            const cached = await cachedFile(base)
            if (this.state.get().description !== description) {
                return
            }
            if (cached?.hash === hash) {
                counts.hit++
                counts.hitBytes += cached.data.byteLength
                // a copy that won't decode is asked for again
                loads.push(this.#load(uri, cached.data).then((loaded) => loaded || this.#failed.delete(uri)))
            } else if (cached) {
                counts.stale++
                // only a name that already carries a query can carry &have= as well: dimos serves a USD layer's
                // assets by the exact path the layer named, and anything appended makes it no longer that path
                if (splitHash(uri).hash) {
                    this.#have.set(uri, cached.hash)
                }
            } else {
                counts.missing++
            }
        }))
        if (this.state.get().description !== description) {
            return
        }
        this.#cacheChecked = true
        meshLog(`cache: ${counts.hit} hits (${(counts.hitBytes / 1e6).toFixed(1)} MB), ${counts.stale} outdated, ${counts.missing} not cached; looked up ${this.#since()}`)
        this.#askForMeshes()
        if (!loads.length) {
            return
        }
        // a cached copy that didn't decode is asked for now
        await Promise.all(loads)
        this.#askForMeshes()
    }

    #count() {
        const description = this.state.get().description
        const loaded = description ? meshUris(description).filter(this.#loaded).length : 0
        this.state.update({ meshesLoaded: loaded, meshVersion: this.state.get().meshVersion + 1 })
        for (const [rank, name] of ["robot", "scene tiles", "splats"].entries()) {
            const files = this.#files.filter((uri) => this.#ranks.get(uri) === rank)
            if (files.length && !this.#drawnRanks.has(rank) && files.every(this.#loaded)) {
                this.#drawnRanks.add(rank)
                meshLog(`${name} ready (${files.length} files) ${this.#since()}`)
            }
        }
    }

    #askForMeshes() {
        const description = this.state.get().description
        if (!description && this.#users && !this.#descriptionAsk) {
            this.#putDescriptionRequests()
        }
        if (!description || !this.connection.client || !this.#users || !this.#cacheChecked) {
            return
        }
        const now = Date.now()
        for (const [uri, at] of this.#asked) {
            if (now - at > (isSplatName(uri) ? Math.max(SPLAT_RETRY_MS, this.meshRetryMs) : this.meshRetryMs)) {
                this.#asked.delete(uri)
            }
        }
        const missing = this.#files.filter((uri) => !this.#loaded(uri) && !this.#decoding.has(uri) && !this.#failed.has(uri) && !this.#asked.has(uri))
        const requests = this.#publisher(this.#meshRequestKey ?? FILE_REQUEST)!
        for (const uri of missing.slice(0, Math.max(0, MESHES_IN_FLIGHT - this.#asked.size))) {
            const have = this.#have.get(uri)
            try {
                requests.put(encode("std_msgs.String", { data: have ? `${uri}&have=${have}` : uri }))
                meshLog(`asked for ${uri.split("/").pop()?.split("?")[0]}${have ? " (cached copy outdated)" : ""} ${this.#since()}`)
                this.#asked.set(uri, now)
            } catch {
                // not open yet: the next tick asks
                return
            }
        }
    }

    #since = () => `${Math.round(performance.now() - this.#descriptionAt)} ms after the description`

    /** a layer instance starts or stops drawing the model */
    drawing(change: 1 | -1) {
        this.state.update({ drawing: Math.max(0, this.state.get().drawing + change) })
    }
}

/** a splat file by its name alone (a .ply could be either: treated as a mesh until it arrives) */
const isSplatName = (uri: string) => splatFileType(uri, new Uint8Array()) !== null

/** Each file the URDF names, ranked by when it's wanted: 0 the robot's own, 1 those on links fixed to the root (a
 * scene's big tiles), 2 splat files. */
export function fileRanks(description: RobotDescription): Map<string, number> {
    const children = new Set(description.joints.map((joint) => joint.child))
    const fixed = new Set(description.links.filter((link) => !children.has(link.name)).map((link) => link.name))
    for (let grew = true; grew;) {
        grew = false
        for (const joint of description.joints) {
            if (joint.type === "fixed" && fixed.has(joint.parent) && !fixed.has(joint.child)) {
                fixed.add(joint.child)
                grew = true
            }
        }
    }
    const ranks = new Map<string, number>()
    for (const link of description.links) {
        for (const { mesh } of [...link.visuals, ...link.collisions]) {
            if (mesh) {
                ranks.set(mesh, Math.min(ranks.get(mesh) ?? 2, isSplatName(mesh) ? 2 : fixed.has(link.name) ? 1 : 0))
            }
        }
    }
    return ranks
}

const sources = new WeakMap<Connection, UrdfSource>()

/** The page's one UrdfSource for its connection. */
export function urdfSource(connection: Connection): UrdfSource {
    let source = sources.get(connection)
    if (!source) {
        source = new UrdfSource(connection)
        sources.set(connection, source)
    }
    return source
}

/** The text's SHA-256, or its 64-bit FNV-1a over plain http (crypto.subtle is only there in a secure context): a cache key either way */
async function textHash(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    if (!globalThis.crypto?.subtle) {
        let hash = 0xcbf29ce484222325n
        for (const byte of bytes) {
            hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
        }
        return `fnv1a64-${hash.toString(16).padStart(16, "0")}`
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
