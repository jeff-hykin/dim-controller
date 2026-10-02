// sensor_msgs.Image / CompressedImage in 3D: the camera's frustum, with the live picture on its far plane, placed
// at the camera's TF frame. Intrinsics come from the matching CameraInfo topic (or a 70° guess without one).
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { placeInFixedFrame, subscribeDecoded } from "../core/layers/helpers.ts"
import { headerFrameId } from "../core/lcm/lcm.ts"
import { FatLines } from "../core/render/lines.ts"
import { useStore, type Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { cameraInfoFor, isDepthTopic } from "../core/video.ts"
import { Field, Select, Slider, Toggle } from "../ui/controls.tsx"

export interface Camera3dSettings {
    /** meters from the camera to the picture */
    distance: number
    opacity: number
    image: boolean
    frustum: boolean
    /** "optical": z forward, x right, y down (ROS *_optical_frame); "body": x forward, y left, z up */
    convention: "auto" | "optical" | "body"
}

interface Intrinsics {
    width: number
    height: number
    fx: number
    fy: number
    cx: number
    cy: number
}

// optical (x right, y down, z forward) → body (x forward, y left, z up)
const OPTICAL_TO_BODY = new THREE.Matrix4().set(0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1)

class Camera3dLayer {
    readonly root = new THREE.Group()
    #content = new THREE.Group()
    #plane: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>
    #frustum: FatLines
    #texture: THREE.VideoTexture | null = null
    #frame: string | null = null
    #intrinsics: Intrinsics | null = null
    #infoKey = ""
    #stopInfo: (() => void) | null = null
    #stopFrame: (() => void) | null = null
    #source
    #element: HTMLVideoElement
    #videoCallback = 0
    #lastShape = ""
    #checkedInfoAt = 0

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<Camera3dSettings>) {
        this.#content.matrixAutoUpdate = false
        this.root.add(this.#content)
        this.#frustum = new FatLines(context.viewer.resolution, { width: 1.5, color: 0xffd166 })
        this.#plane = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, toneMapped: false }))
        this.#content.add(this.#plane, this.#frustum.object)
        this.#source = context.video.acquire(topic)
        this.#element = context.video.element(this.#source)
        this.#texture = new THREE.VideoTexture(this.#element)
        this.#texture.colorSpace = THREE.SRGBColorSpace
        this.#plane.material.map = this.#texture
        // the view only redraws on demand, so each decoded video frame asks for one
        const onVideoFrame = () => {
            context.viewer.requestRender()
            this.#videoCallback = this.#element.requestVideoFrameCallback(onVideoFrame)
        }
        this.#videoCallback = this.#element.requestVideoFrameCallback(onVideoFrame)
        settings.subscribe(() => this.#reshape(true))
        if (isDepthTopic(topic)) {
            context.setStatus({ problem: "depth images aren't projected (use a point cloud)" })
        }
        this.#findInfo()
    }

    /**
     * The image's own frame comes from one raw image; intrinsics from the CameraInfo whose frame_id is that frame.
     * Several cameras can share one CameraInfo topic (Spot publishes all five on one port), so every info topic is
     * read and only messages for this camera's frame are used; the name-matched topic is the fallback when an info
     * carries no frame_id.
     */
    #findInfo() {
        this.#checkedInfoAt = performance.now()
        if (this.#frame === null && !this.#stopFrame) {
            this.#stopFrame = this.context.connection.subscribe(this.topic.key, { delivery: "latest", maxHz: 1 }, (message) => {
                const frame = headerFrameId(this.topic.type, message.bytes)
                if (frame === null) {
                    return
                }
                this.#frame = frame
                this.#stopFrame?.()
                this.#stopFrame = null
                this.#reshape(false)
            })
        }
        const infos = this.context.topics().filter((topic) => topic.type === "sensor_msgs.CameraInfo")
        const key = infos.map((topic) => topic.key).join(",")
        if (key === this.#infoKey || this.#intrinsics) {
            return
        }
        this.#stopInfo?.()
        this.#infoKey = key
        const named = cameraInfoFor(this.topic, infos, this.context.profile.cameras.cameraInfo)
        const stops = infos.map((info) =>
            subscribeDecoded(this.context, info, { maxHz: 30, reliable: true }, (message) => {
                const K = message.K ?? []
                const infoFrame = message.header?.frame_id ?? ""
                const mine = infoFrame ? infoFrame === this.#frame : info.key === named?.key
                if (!mine || !message.width || !K[0]) {
                    return
                }
                this.#intrinsics = { width: message.width, height: message.height, fx: K[0], fy: K[4], cx: K[2], cy: K[5] }
                // intrinsics don't change: stop listening (a shared port is busy)
                this.#stopInfo?.()
                this.#stopInfo = null
                this.#reshape(false)
            })
        )
        this.#stopInfo = () => stops.forEach((stop) => stop())
    }

    #reshape(force: boolean) {
        const settings = this.settings.get()
        const video = this.#source.video.get()
        const intrinsics = this.#intrinsics ?? (video.width ? guess(video.width, video.height) : null)
        if (!intrinsics) {
            return
        }
        const shape = `${JSON.stringify(intrinsics)}/${settings.distance}/${settings.convention}/${this.#frame}`
        if (shape === this.#lastShape && !force) {
            return
        }
        this.#lastShape = shape
        const d = settings.distance
        const corner = (u: number, v: number) => new THREE.Vector3(((u - intrinsics.cx) / intrinsics.fx) * d, ((v - intrinsics.cy) / intrinsics.fy) * d, d)
        const [topLeft, topRight, bottomRight, bottomLeft] = [corner(0, 0), corner(intrinsics.width, 0), corner(intrinsics.width, intrinsics.height), corner(0, intrinsics.height)]
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute("position", new THREE.Float32BufferAttribute([...topLeft.toArray(), ...topRight.toArray(), ...bottomRight.toArray(), ...bottomLeft.toArray()], 3))
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
        geometry.setIndex([0, 1, 2, 0, 2, 3])
        this.#plane.geometry.dispose()
        this.#plane.geometry = geometry
        this.#plane.material.opacity = settings.opacity
        this.#plane.visible = settings.image
        this.#frustum.clear()
        for (const corner of [topLeft, topRight, bottomRight, bottomLeft]) {
            this.#frustum.push(0, 0, 0, corner.x, corner.y, corner.z)
        }
        for (const [a, b] of [[topLeft, topRight], [topRight, bottomRight], [bottomRight, bottomLeft], [bottomLeft, topLeft]]) {
            this.#frustum.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
        this.#frustum.commit()
        this.#frustum.object.visible = settings.frustum
        const optical = settings.convention === "optical" || (settings.convention === "auto" && /optical/i.test(this.#frame ?? ""))
        this.#content.matrix.copy(optical ? new THREE.Matrix4() : OPTICAL_TO_BODY)
        this.#content.matrixWorldNeedsUpdate = true
        this.context.setStatus({ info: `${intrinsics.width}×${intrinsics.height}${this.#intrinsics ? "" : " (no CameraInfo: 70° guess)"} · ${optical ? "optical" : "body"} frame ${this.#frame || "?"}` })
        this.context.viewer.requestRender()
    }

    update(frame: { now: number; fixedFrame: string }) {
        if (!this.#intrinsics && frame.now - this.#checkedInfoAt > 2000) {
            this.#findInfo()
        }
        if (this.#frame !== null) {
            if (placeInFixedFrame(this.context, this.root, this.#frame, frame.fixedFrame)) {
                this.#reshape(false)
            }
        }
    }

    dispose() {
        this.#element.cancelVideoFrameCallback(this.#videoCallback)
        this.#stopInfo?.()
        this.#stopFrame?.()
        this.context.video.release(this.topic)
        this.#texture?.dispose()
        this.#plane.geometry.dispose()
        this.#plane.material.dispose()
        this.#frustum.dispose()
    }
}

function guess(width: number, height: number): Intrinsics {
    const fx = width / 2 / Math.tan(THREE.MathUtils.degToRad(70) / 2)
    return { width, height, fx, fy: fx, cx: width / 2, cy: height / 2 }
}

function Camera3dSettingsEditor({ settings }: { settings: Store<Camera3dSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <Field label="Picture"><Toggle value={value.image} onChange={(image) => settings.update({ image })} /></Field>
            <Field label="Frustum"><Toggle value={value.frustum} onChange={(frustum) => settings.update({ frustum })} /></Field>
            <Field label="Distance"><Slider min={0.2} max={10} step={0.1} value={value.distance} format={(distance) => `${distance.toFixed(1)} m`} onChange={(distance) => settings.update({ distance })} /></Field>
            <Field label="Opacity"><Slider min={0.1} max={1} step={0.05} value={value.opacity} format={(opacity) => `${Math.round(opacity * 100)}%`} onChange={(opacity) => settings.update({ opacity })} /></Field>
            <Field label="Frame">
                <Select value={value.convention} options={[["auto", "auto (by name)"], ["optical", "optical (z forward)"], ["body", "body (x forward)"]]} onChange={(convention) => settings.update({ convention: convention as Camera3dSettings["convention"] })} />
            </Field>
        </>
    )
}

registerLayer<Camera3dSettings>({
    id: "camera3d",
    label: "Camera in 3D",
    types: ["sensor_msgs.Image", "sensor_msgs.CompressedImage"],
    defaults: { distance: 1.5, opacity: 0.95, image: true, frustum: true, convention: "auto" },
    // the camera panels show images; projecting one into the scene is opt-in
    enabledByDefault: () => false,
    create: (context: LayerContext, topic, settings) => new Camera3dLayer(context, topic, settings),
    Settings: Camera3dSettingsEditor,
})
