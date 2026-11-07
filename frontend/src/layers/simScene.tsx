// A simulated world: built once a sim answers, its bodies that move (the scripted movers) moved by their TF frames. A sim
// answers the UrdfManager way (core/simSceneSource.ts: "sim_scene.json" on /render_file_request, a dimos.scene_data.v2
// index naming STL and PNG files, all on /file_info; the layer manager shows this layer once one has come). An older sim
// says it's there on /scene_info and answers /scene_data_request with the whole world inline (dimos.scene_data.v1) on
// /scene_data: this layer asks that too until a scene comes.
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { disposeTree } from "../core/layers/helpers.ts"
import { decode, encode } from "../core/lcm/lcm.ts"
import { Store, useStore } from "../core/store.ts"
import { dimosKey, type Publisher, type Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "dimos-react"
import { buildScene, type SceneData, sceneFileNames } from "../core/sceneData.ts"
import { simSceneSource } from "../core/simSceneSource.ts"
import { SimLighting } from "../core/simLighting.ts"
import { bladeCount, isSoftwareRenderer, probeRendererName, windTime } from "../core/grass.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { rendering } from "../core/render/rendering.ts"
import { applyMeshStyle } from "../core/render/meshStyle.ts"

export const SCENE_DATA = dimosKey("/scene_data", "std_msgs.String")
export const SCENE_DATA_REQUEST = dimosKey("/scene_data_request", "std_msgs.String")
/** how often to ask an older sim until it answers (the sim may start after the page) */
const ASK_EVERY_MS = 3000

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
    /** the TF frame the scene's coordinates are in (its scene_data's `frame`) */
    #frame = "world"
    #stops: (() => void)[] = []
    #asking: ReturnType<typeof setInterval>
    #requests: Publisher | null = null
    #unsubscribeGrass: () => void
    #unsubscribeRendering: () => void
    #lighting: SimLighting
    #source: ReturnType<typeof simSceneSource>

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<SimSceneSettings>) {
        this.#lighting = new SimLighting(context.viewer.renderer)
        // the layer manager keeps it asking
        this.#source = simSceneSource(context.connection)
        // scene coordinates are the world frame; the layer root is re-placed in the view's fixed frame every frame
        this.root.matrixAutoUpdate = false
        settings.subscribe(() => this.#applySettings())
        this.#unsubscribeGrass = grassSettings().subscribe(() => this.#applySettings())
        this.#unsubscribeRendering = rendering.subscribe(() => this.#applySettings())
        // a v2 scene: drawn when it comes, again as each of its files does
        let shown: { data: SceneData | null; filesVersion: number } = { data: null, filesVersion: -1 }
        const fromSource = () => {
            const { data, filesVersion, problem } = this.#source.state.get()
            if (problem) {
                context.setStatus({ problem })
            }
            if (data && (data !== shown.data || filesVersion !== shown.filesVersion)) {
                shown = { data, filesVersion }
                this.#show(data)
            }
        }
        this.#stops.push(this.#source.state.subscribe(fromSource))
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
        fromSource()
        this.#ask()
        this.#asking = setInterval(() => this.#ask(), ASK_EVERY_MS)
    }

    /** an older sim's scene, asked for until a scene (of either kind) is here */
    #ask() {
        if (this.#scene) {
            return
        }
        const client = this.context.connection.client
        if (!client) {
            return
        }
        this.#requests ??= client.publisher(SCENE_DATA_REQUEST, { delivery: "reliable" })
        try {
            this.#requests.put(encode("std_msgs.String", { data: "dim-controller" }))
        } catch {
            // not open yet: the next tick asks again
        }
    }

    #show(data: SceneData) {
        if (this.#scene) {
            this.root.remove(this.#scene.root)
            disposeTree(this.#scene.root)
        }
        this.#scene = buildScene(data, this.#source.files)
        this.#id = data.id
        this.#frame = data.frame || "world"
        this.root.add(this.#scene.root)
        this.#lighting.light(this.#scene.root)
        this.#applySettings()
        const geoms = data.bodies.reduce((count, body) => count + body.geoms.length, 0)
        const movers = data.bodies.filter((body) => body.mocap).length
        const { loaded, wanted } = sceneFileNames(data).length ? this.#source.progress() : { loaded: 0, wanted: 0 }
        this.#info = `${data.id} · ${data.bodies.length} bodies · ${geoms} geoms · ${Object.keys(data.meshes).length} meshes${movers ? ` · ${movers} moving` : ""}${loaded < wanted ? ` · ${loaded}/${wanted} files` : ""}`
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
    // an older sim's /scene_info, or the same key the layer manager adds once a v2 scene has come
    names: ["/scene_info"],
    defaults: { opacity: 1, cutAbove: 2.5, lights: false, shadows: true },
    create: (context, topic, settings) => new SimSceneLayer(context, topic, settings),
    Settings: SimSceneSettingsEditor,
})
