// The kinds of panel the settings drawer offers (Camera, 3D view, 2D map, Plot, Transforms, Settings), which streams each could
// show that no open panel shows (a thumbnail's count), and the Settings button's count: those streams, but only for
// kinds never used on this device. Pure: test/panelCatalog.test.ts.
import { isImage } from "../core/cameraChoice.ts"
import { SCALAR_TYPES } from "../core/plot.ts"
import type { Topic } from "../core/transport.ts"
import { isCamera, isPlot } from "./workspace.ts"

export type PanelKind = "camera" | "scene" | "map" | "plot" | "tf" | "settings"

export const PANEL_KINDS: { kind: PanelKind; title: string; icon: string; about: string }[] = [
    { kind: "camera", title: "Camera", icon: "camera", about: "a camera or depth stream" },
    { kind: "scene", title: "3D view", icon: "cube", about: "lidar, TF, the robot, markers" },
    { kind: "map", title: "2D Map", icon: "map", about: "costmap or lidar from above" },
    { kind: "plot", title: "Plot", icon: "plot", about: "numbers over time" },
    { kind: "tf", title: "Transforms", icon: "tree", about: "the TF tree, the fixed frame, TF problems" },
    { kind: "settings", title: "Settings", icon: "settings", about: "these settings, as a panel" },
]

/** the kind a workspace panel is (null: none of these) */
export function kindOf(id: string): PanelKind | null {
    if (isCamera(id)) {
        return "camera"
    }
    if (isPlot(id)) {
        return "plot"
    }
    return id === "scene" || id === "map" || id === "settings" || id === "tf" ? id : null
}

export interface Shown {
    /** the kinds with a panel open */
    open: Set<PanelKind>
    /** the image topics the camera panels show */
    cameraKeys: Set<string>
    /** the topics some plot reads */
    plottedKeys: Set<string>
}

const isCloud = (topic: Topic) => topic.type === "sensor_msgs.PointCloud2"
const isGrid = (topic: Topic) => topic.type === "nav_msgs.OccupancyGrid"

/** The streams a panel of `kind` could show that nothing shows now. */
export function unshownStreams(kind: PanelKind, topics: Topic[], shown: Shown): Topic[] {
    switch (kind) {
        case "camera":
            return topics.filter((topic) => isImage(topic) && !shown.cameraKeys.has(topic.key))
        case "scene":
            return shown.open.has("scene") ? [] : topics.filter(isCloud)
        case "map":
            return shown.open.has("map") ? [] : topics.filter(isGrid)
        case "plot":
            return topics.filter((topic) => SCALAR_TYPES.has(topic.type) && !shown.plottedKeys.has(topic.key))
        default:
            return []
    }
}

/** The Settings button's number: the streams each never-used kind could show. */
export function settingsBadge(topics: Topic[], shown: Shown, used: Set<PanelKind>): number {
    return PANEL_KINDS.filter(({ kind }) => !used.has(kind)).reduce((sum, { kind }) => sum + unshownStreams(kind, topics, shown).length, 0)
}

/** The kinds used on this device (any panel of it ever opened), kept in localStorage. */
export const USED_KEY = "lv.panelKindsUsed"

export function loadUsedKinds(): Set<PanelKind> {
    try {
        const saved = JSON.parse(localStorage.getItem(USED_KEY) ?? "[]")
        return new Set(Array.isArray(saved) ? saved.filter((kind) => PANEL_KINDS.some((one) => one.kind === kind)) : [])
    } catch {
        return new Set()
    }
}

export function saveUsedKinds(used: Set<PanelKind>) {
    try {
        localStorage.setItem(USED_KEY, JSON.stringify([...used]))
    } catch {
        // no storage: counted again next visit
    }
}
