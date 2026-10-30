// A simulated world's default light: an even room light on every surface (an environment map, so shapes read from
// any side) and one sun fitted to the world's bounds that casts soft shadows. The world's own lights stay optional.
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

/** how bright the room light is on sim surfaces, beside the view's own sky and sun */
const ROOM_INTENSITY = 0.55
const SUN_INTENSITY = 1.4
/** the sun comes from up high and to one side (world z up) */
const SUN_DIRECTION = new THREE.Vector3(-0.45, -0.3, 1).normalize()
/** shadows cover at most this far (m) from the world's middle, so a 1 km outdoor world keeps sharp shadows */
const SHADOW_REACH = 40
const SHADOW_MAP_SIZE = 2048

const roomMaps = new WeakMap<THREE.WebGLRenderer, THREE.Texture>()
/** the room light, made once per renderer */
function roomMap(renderer: THREE.WebGLRenderer): THREE.Texture {
    let map = roomMaps.get(renderer)
    if (!map) {
        const pmrem = new THREE.PMREMGenerator(renderer)
        const room = new RoomEnvironment()
        map = pmrem.fromScene(room, 0.04).texture
        room.dispose()
        pmrem.dispose()
        roomMaps.set(renderer, map)
    }
    return map
}

/** the box around a world's meshes in its own frame, leaving out planes (an infinite floor would swamp it) */
export function worldBounds(root: THREE.Object3D): THREE.Box3 {
    const bounds = new THREE.Box3()
    root.updateMatrixWorld(true)
    const toRoot = root.matrixWorld.clone().invert()
    root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || mesh.userData.plane || mesh.userData.grass) {
            return
        }
        mesh.geometry.computeBoundingBox()
        const inRoot = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld)
        bounds.union(new THREE.Box3().copy(mesh.geometry.boundingBox!).applyMatrix4(inRoot))
    })
    return bounds
}

export class SimLighting {
    readonly sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY)

    constructor(readonly renderer: THREE.WebGLRenderer | null) {
        this.sun.name = "sim sun"
        this.sun.castShadow = true
        this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
        this.sun.shadow.bias = -0.0005
        this.sun.shadow.normalBias = 0.02
        this.sun.shadow.radius = 3
        if (renderer && !renderer.shadowMap.enabled) {
            renderer.shadowMap.enabled = true
            renderer.shadowMap.type = THREE.PCFSoftShadowMap
        }
    }

    /** Lights a freshly built world: the sun goes into its root (fitted to it), every surface gets the room light. */
    light(root: THREE.Object3D) {
        const map = this.renderer ? roomMap(this.renderer) : null
        root.traverse((object) => {
            const mesh = object as THREE.Mesh
            if (!mesh.isMesh) {
                return
            }
            const material = mesh.material as THREE.MeshStandardMaterial
            if (material.isMeshStandardMaterial) {
                material.envMap = map
                material.envMapIntensity = ROOM_INTENSITY
                material.needsUpdate = true
            }
        })
        const bounds = worldBounds(root)
        if (bounds.isEmpty()) {
            bounds.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 10, 2))
        }
        const center = bounds.getCenter(new THREE.Vector3())
        const reach = Math.min(bounds.getSize(new THREE.Vector3()).length() / 2 + 1, SHADOW_REACH)
        this.sun.position.copy(center).addScaledVector(SUN_DIRECTION, reach * 2)
        this.sun.target.position.copy(center)
        const shadow = this.sun.shadow.camera
        shadow.left = shadow.bottom = -reach
        shadow.right = shadow.top = reach
        shadow.near = 0.1
        shadow.far = reach * 4
        shadow.updateProjectionMatrix()
        root.add(this.sun, this.sun.target)
    }

    /** the sun's shadows on or off (the room light stays) */
    set shadows(on: boolean) {
        this.sun.castShadow = on
    }
}
