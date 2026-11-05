// A simulated world: the sim says it's there with its scene's id on /scene_info, and this layer asks for the scene until
// one answers (and again when the id changes), builds the world, and moves the bodies that move (the scripted movers)
// by their TF frames. The sim answers the way UrdfManager does: "sim_scene.json" asked for on /render_file_request comes
// on /file_info as a dimos.scene_data.v2 index, which names a file for each mesh (STL) and texture (PNG), each asked for
// the same way; the world is drawn at once and redrawn as they come. An older sim answers /scene_data_request with the
// whole world inline (dimos.scene_data.v1) on /scene_data: both are asked until one answers.
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { disposeTree } from "../core/layers/helpers.ts"
import { decode, encode } from "../core/lcm/lcm.ts"
import { Store, useStore } from "../core/store.ts"
import { dimosKey, Priority, type Publisher, type Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "dimos-react"
import { buildScene, type SceneData, type SceneFiles, sceneFileNames } from "../core/sceneData.ts"
import { FILE_INFO, FILE_REQUEST } from "../core/urdfSource.ts"
import { decodeMeshFile, meshGeometry } from "dimos-react/three"
import { SimLighting } from "../core/simLighting.ts"
import { bladeCount, isSoftwareRenderer, probeRendererName, windTime } from "../core/grass.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { rendering } from "../core/render/rendering.ts"
import { applyMeshStyle } from "../core/render/meshStyle.ts"

export const SCENE_DATA = dimosKey("/scene_data", "std_msgs.String")
export const SCENE_DATA_REQUEST = dimosKey("/scene_data_request", "std_msgs.String")
/** the v2 scene's index, as asked for on /render_file_request */
const SCENE_FILE = "sim_scene.json"
/** how often to ask until a sim answers (the sim may start after the page) */
const ASK_EVERY_MS = 3000
/** files asked for at once, as the robot model's meshes (core/urdfSource.ts) */
const FILES_IN_FLIGHT = 2
/** a file asked for this long ago without a reply is asked for again */
const FILE_RETRY_MS = 60000

/** a PNG's pixels as RGBA, rows top first (as the sim wrote them) */
async function pngPixels(data: Uint8Array): Promise<Uint8Array> {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: "image/png" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" })
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext("2d")!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const image = context.getImageData(0, 0, canvas.width, canvas.height)
    return new Uint8Array(image.data.buffer)
}

export interface SimSceneSettings {
    opacity: number
    /** geoms that start above this height (m) are left out, so ceilings and upper floors don't hide the robot */
    cutAbove: number
    /** add the world's own lights to the view's */
    lights: boolean
    /** the default sun casts shadows */
    shadows: boolean
}

let gpuName: string | null = null
/** the GPU's name, asked once (a throwaway WebGL context) */
function gpu(): string {
    gpuName ??= probeRendererName()
    return gpuName
}

/** Grass is per viewer, like the camera and cloud presets: a laptop without a GPU wants it off, a desktop on. */
export interface GrassSettings {
    /** blades on the world's grass height fields (off by default on a software GPU) */
    on: boolean
    /** 1 = the default look; lower for a weak GPU */
    density: number
    /** wind sway: the view keeps redrawing while grass is on screen */
    sway: boolean
}
const GRASS_KEY = "lv.sim.grass"
let grassStore: Store<GrassSettings> | null = null
export function grassSettings(): Store<GrassSettings> {
    if (!grassStore) {
        // thousands of blades on a CPU renderer would crawl: off there unless this viewer turned it on
        const defaults: GrassSettings = { on: !isSoftwareRenderer(gpu()), density: 1, sway: true }
        const store = new Store<GrassSettings>({ ...defaults, ...readLocal<Partial<GrassSettings>>(GRASS_KEY, {}) })
        store.subscribe(() => writeLocal(GRASS_KEY, store.get()))
        grassStore = store
    }
    return grassStore
}

/** a geom's lowest point in world coordinates (its body's pose included), to cut ceilings by */
function lowestZ(mesh: THREE.Mesh): number {
    mesh.geometry.computeBoundingBox()
    const body = mesh.parent!
    body.updateMatrix()
    mesh.updateMatrix()
    const inWorld = new THREE.Matrix4().multiplyMatrices(body.matrix, mesh.matrix)
    return new THREE.Box3().copy(mesh.geometry.boundingBox!).applyMatrix4(inWorld).min.z
}

class SimSceneLayer {
    readonly root = new THREE.Group()
    #scene: ReturnType<typeof buildScene> | null = null
    #id: string | null = null
    /** the scene drawn (rebuilt as its files come) */
    #data: SceneData | null = null
    /** the scene id /scene_info last said */
    #announced: string | null = null
    #files: SceneFiles = { geometries: new Map(), pixels: new Map() }
    /** file name -> when it was last asked for */
    #asked = new Map<string, number>()
    #failed = new Set<string>()
    #askedAt = 0
    /** the TF frame the scene's coordinates are in (its scene_data's `frame`) */
    #frame = "world"
    #stops: (() => void)[] = []
    #asking: ReturnType<typeof setInterval>
    #requests: Publisher | null = null
    #fileRequests: Publisher | null = null
    #unsubscribeGrass: () => void
    #unsubscribeRendering: () => void
    #lighting: SimLighting

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<SimSceneSettings>) {
        this.#lighting = new SimLighting(context.viewer.renderer)
        // scene coordinates are the world frame; the layer root is re-placed in the view's fixed frame every frame
        this.root.matrixAutoUpdate = false
        settings.subscribe(() => this.#applySettings())
        this.#unsubscribeGrass = grassSettings().subscribe(() => this.#applySettings())
        this.#unsubscribeRendering = rendering.subscribe(() => this.#applySettings())
        this.#stops.push(context.connection.subscribe(topic.key, { delivery: "latest" }, (message) => {
            try {
                this.#announced = String(decode("std_msgs.String", message.bytes).data ?? "") || null
            } catch {
                return
            }
            if (this.#announced && this.#announced !== this.#id) {
                this.#ask()
            }
        }))
        this.#stops.push(context.connection.subscribe(FILE_INFO, { delivery: "reliable", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onFile(message.bytes)))
        this.#stops.push(context.connection.subscribe(SCENE_DATA, { delivery: "reliable" }, (message) => {
            let data: SceneData
            try {
                data = JSON.parse(String(decode("std_msgs.String", message.bytes).data)) as SceneData
            } catch (error) {
                context.setStatus({ problem: `not a dimos.scene_data.v1 message: ${error}` })
                return
            }
            if (data.format !== "dimos.scene_data.v1" || data.id === this.#id) {
                return
            }
            this.#show(data)
        }))
        context.setStatus({ info: "asking for the scene", problem: null })
        this.#ask()
        this.#asking = setInterval(() => this.#tick(), 1000)
    }

    /** every second: the scene asked for again while there's none (or /scene_info names another), files re-asked */
    #tick() {
        if ((!this.#id || (this.#announced && this.#announced !== this.#id)) && Date.now() - this.#askedAt >= ASK_EVERY_MS) {
            this.#ask()
        }
        this.#askForFiles()
    }

    #ask() {
        const client = this.context.connection.client
        if (!client) {
            return
        }
        this.#askedAt = Date.now()
        this.#requests ??= client.publisher(SCENE_DATA_REQUEST, { delivery: "reliable" })
        this.#fileRequests ??= client.publisher(FILE_REQUEST, { delivery: "reliable" })
        try {
            this.#fileRequests.put(encode("std_msgs.String", { data: SCENE_FILE }))
            this.#requests.put(encode("std_msgs.String", { data: "dim-controller" }))
        } catch {
            // not open yet: the next tick asks again
        }
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
            let data: SceneData
            try {
                data = JSON.parse(new TextDecoder().decode(file.data)) as SceneData
            } catch (error) {
                this.context.setStatus({ problem: `${SCENE_FILE} isn't JSON: ${error}` })
                return
            }
            if (data.format !== "dimos.scene_data.v2" || data.id === this.#id) {
                return
            }
            this.#files = { geometries: new Map(), pixels: new Map() }
            this.#asked.clear()
            this.#failed.clear()
            this.#show(data)
            this.#askForFiles()
            return
        }
        const data = this.#data
        // another layer's file (the robot's meshes), or one already here
        if (!data || !sceneFileNames(data).includes(file.uri) || this.#asked.get(file.uri) === -1 || this.#files.geometries.has(file.uri) || this.#files.pixels.has(file.uri)) {
            return
        }
        // -1: decoding
        this.#asked.set(file.uri, -1)
        this.#load(data, file.uri, file.data)
        this.#askForFiles()
    }

    async #load(data: SceneData, name: string, bytes: Uint8Array) {
        try {
            if (name.endsWith(".png")) {
                const pixels = await pngPixels(bytes)
                if (this.#data !== data) {
                    return
                }
                this.#files.pixels.set(name, pixels)
            } else {
                this.#files.geometries.set(name, meshGeometry(name, bytes))
            }
            this.#show(data)
        } catch (error) {
            this.#failed.add(name)
            this.context.setStatus({ problem: `${name}: ${error}` })
        } finally {
            if (this.#asked.get(name) === -1) {
                this.#asked.delete(name)
            }
        }
    }

    #askForFiles() {
        const data = this.#data
        const client = this.context.connection.client
        if (!data || !client) {
            return
        }
        const now = Date.now()
        for (const [name, at] of this.#asked) {
            if (at !== -1 && now - at > FILE_RETRY_MS) {
                this.#asked.delete(name)
            }
        }
        const missing = sceneFileNames(data).filter((name) => !this.#files.geometries.has(name) && !this.#files.pixels.has(name) && !this.#failed.has(name) && !this.#asked.has(name))
        this.#fileRequests ??= client.publisher(FILE_REQUEST, { delivery: "reliable" })
        for (const name of missing.slice(0, Math.max(0, FILES_IN_FLIGHT - this.#asked.size))) {
            try {
                this.#fileRequests.put(encode("std_msgs.String", { data: name }))
                this.#asked.set(name, now)
            } catch {
                // not open yet: the next tick asks
                return
            }
        }
    }

    #show(data: SceneData) {
        if (this.#scene) {
            this.root.remove(this.#scene.root)
            disposeTree(this.#scene.root)
        }
        this.#scene = buildScene(data, this.#files)
        this.#id = data.id
        this.#data = data
        this.#frame = data.frame || "world"
        this.root.add(this.#scene.root)
        this.#lighting.light(this.#scene.root)
        this.#applySettings()
        const geoms = data.bodies.reduce((count, body) => count + body.geoms.length, 0)
        const movers = data.bodies.filter((body) => body.mocap).length
        const files = sceneFileNames(data)
        const loaded = files.filter((name) => this.#files.geometries.has(name) || this.#files.pixels.has(name)).length
        this.#info = `${data.id} · ${data.bodies.length} bodies · ${geoms} geoms · ${Object.keys(data.meshes).length} meshes${movers ? ` · ${movers} moving` : ""}${loaded < files.length ? ` · ${loaded}/${files.length} files` : ""}`
        this.#status()
        this.context.viewer.requestRender()
    }

    #applySettings() {
        const scene = this.#scene
        if (!scene) {
            return
        }
        const { opacity, cutAbove, lights, shadows } = this.settings.get()
        const { on: grass, density: grassDensity } = grassSettings().get()
        scene.root.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (!mesh.isMesh || mesh.userData.grass) {
                return
            }
            const material = mesh.material as THREE.MeshStandardMaterial
            const alpha = (mesh.userData.baseOpacity as number) * opacity
            material.opacity = alpha
            material.transparent = alpha < 1
            material.depthWrite = alpha >= 1
            mesh.visible = lowestZ(mesh) <= cutAbove
        })
        const { meshStyle, wireframeColor } = rendering.get()
        applyMeshStyle(scene.root, meshStyle, wireframeColor)
        for (const light of scene.lights) {
            light.visible = lights
        }
        this.#lighting.shadows = shadows !== false
        for (const blades of scene.grass) {
            blades.mesh.count = Math.min(blades.mesh.instanceMatrix.count, bladeCount(blades.area, grassDensity))
            blades.mesh.visible = grass && blades.mesh.count > 0
        }
        this.#status()
        this.context.viewer.requestRender()
    }

    #info = ""
    #status() {
        const scene = this.#scene
        const grass = grassSettings().get().on
        let note = ""
        if (scene?.grass.length) {
            const blades = scene.grass.reduce((sum, field) => sum + (field.mesh.visible ? field.mesh.count : 0), 0)
            note = grass
                ? ` · ${Math.round(blades / 1000)}k grass blades`
                : isSoftwareRenderer(gpu())
                ? ` · grass off: software GPU (${gpu()})`
                : " · grass off"
        }
        this.context.setStatus({ info: this.#info + note, problem: null, frame: this.#frame })
    }

    update(frame: { fixedFrame: string; now: number }) {
        const scene = this.#scene
        if (!scene) {
            return
        }
        // the wind: only while grass is shown and swaying, since it keeps the view redrawing
        const { on: grass, sway } = grassSettings().get()
        if (grass && sway && scene.grass.some((field) => field.mesh.visible)) {
            windTime.value = frame.now / 1000
            this.context.viewer.requestRender()
        }
        const world = this.context.tf.lookup(this.#frame, frame.fixedFrame)
        if (world) {
            if (!this.root.matrix.equals(world)) {
                this.root.matrix.copy(world)
                this.root.matrixWorldNeedsUpdate = true
                this.context.viewer.requestRender()
            }
        }
        // movers: their TF frame (scene frame -> body) wins over the pose they started at
        for (const [name, group] of scene.bodies) {
            if (!group.userData.mocap) {
                continue
            }
            const pose = this.context.tf.lookup(name, this.#frame)
            if (pose) {
                const before = group.position.clone()
                pose.decompose(group.position, group.quaternion, group.scale)
                if (!before.equals(group.position)) {
                    this.context.viewer.requestRender()
                }
            }
        }
    }

    dispose() {
        clearInterval(this.#asking)
        this.#unsubscribeGrass()
        this.#unsubscribeRendering()
        this.#stops.forEach((stop) => stop())
        this.#requests?.close()
        this.#fileRequests?.close()
        if (this.#scene) {
            disposeTree(this.#scene.root)
        }
    }
}

function SimSceneSettingsEditor({ settings }: { settings: Store<SimSceneSettings>; topic: Topic }) {
    const value = useStore(settings)
    const grass = useStore(grassSettings())
    return (
        <>
            <Field inline label="Opacity">
                <Slider min={0.1} max={1} step={0.05} value={value.opacity} format={(opacity) => `${Math.round(opacity * 100)}%`} onChange={(opacity) => settings.update({ opacity })} />
            </Field>
            <Field inline label="Hide above" title="leaves out ceilings and upper floors">
                <Slider min={0.5} max={30} step={0.1} value={value.cutAbove} format={(height) => `${height.toFixed(1)} m`} onChange={(cutAbove) => settings.update({ cutAbove })} />
            </Field>
            <Field inline label="Shadows" title="the default sun's shadows">
                <Toggle value={value.shadows !== false} onChange={(shadows) => settings.update({ shadows })} />
            </Field>
            <Field inline label="The world's lights">
                <Toggle value={value.lights} onChange={(lights) => settings.update({ lights })} />
            </Field>
            <Field inline label="Grass" title={isSoftwareRenderer(gpu()) ? `this viewer only; off by default: ${gpu()} is a software GPU` : "this viewer only: blades on the world's grassy hills"}>
                <Toggle value={grass.on} onChange={(on) => grassSettings().update({ on })} />
            </Field>
            {grass.on && (
                <>
                    <Field inline label="Grass density">
                        <Slider min={0.1} max={2} step={0.05} value={grass.density} format={(density) => `${Math.round(density * 100)}%`} onChange={(density) => grassSettings().update({ density })} />
                    </Field>
                    <Field inline label="Wind" title="keeps the view redrawing while grass is on screen">
                        <Toggle value={grass.sway} onChange={(sway) => grassSettings().update({ sway })} />
                    </Field>
                </>
            )}
        </>
    )
}

registerLayer<SimSceneSettings>({
    id: "sim-scene",
    label: "Simulated world",
    types: ["std_msgs.String"],
    // a sim says it's there on /scene_info (its scene's id, every 2 s); the scene itself only comes when asked
    names: ["/scene_info"],
    defaults: { opacity: 1, cutAbove: 2.5, lights: false, shadows: true },
    create: (context, topic, settings) => new SimSceneLayer(context, topic, settings),
    Settings: SimSceneSettingsEditor,
})
