// The sim robot's own model (public/robots/sim_<robot>.glb, baked from dimos's MuJoCo model by scripts/bake_sim_models.py):
// its visual meshes in the home pose, in the root body's frame, which is the frame dimos's sim publishes as base_link.
// The sim publishes no joint angles, so the model moves and turns with the robot but its legs stay in the home pose.
// Its colors are the robot's (dark grey, light grey), lifted toward the theme's --fg on a dark page so it doesn't vanish
// into the void.
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { themeColors } from "../../dim-app/source/theme.js"
import type { SimRobot } from "../sim.ts"

const loaded = new Map<SimRobot, Promise<THREE.Group>>()

function load(robot: SimRobot): Promise<THREE.Group> {
    let promise = loaded.get(robot)
    if (!promise) {
        promise = new GLTFLoader().loadAsync(`./robots/sim_${robot}.glb`).then((gltf) => gltf.scene)
        loaded.set(robot, promise)
    }
    return promise
}

/** how far a dark page lifts the model's colors toward --fg */
const DARK_LIFT = 0.4

/** The model's colors for the page's theme (its own materials: a clone shares the cached ones). */
function applyTheme(group: THREE.Group) {
    const dark = typeof document !== "undefined" && document.body.classList.contains("dark")
    const fg = new THREE.Color(themeColors().fg || "#e8e6f0")
    group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
            return
        }
        const material = object.material as THREE.MeshStandardMaterial
        const own: THREE.Color = material.userData.baked ??= material.color.clone()
        material.color.copy(own)
        if (dark) {
            material.color.lerp(fg, DARK_LIFT)
        }
    })
}

/** A group drawn at the robot's pose; the meshes join it once they've loaded (then `onLoad`, to redraw). */
export function simModel(robot: SimRobot, onLoad: () => void): THREE.Group {
    const group = new THREE.Group()
    group.name = `sim-model-${robot}`
    group.matrixAutoUpdate = false
    group.renderOrder = 1
    load(robot).then((scene) => {
        const copy = scene.clone(true)
        copy.traverse((object) => {
            if (object instanceof THREE.Mesh) {
                object.material = (object.material as THREE.Material).clone()
            }
        })
        group.add(copy)
        applyTheme(group)
        const retheme = () => {
            if (!group.parent) {
                removeEventListener("dim-theme", retheme)
                return
            }
            applyTheme(group)
            onLoad()
        }
        addEventListener("dim-theme", retheme)
        onLoad()
    }).catch((error) => console.warn(`[sim model] ${robot}:`, error))
    return group
}
