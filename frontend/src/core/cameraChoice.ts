// Which image topic a camera panel shows: the one the viewer picked when it's on the bus, else the profile's preferred
// camera. A saved panel whose topic isn't on the bus (another blueprint, a sim instead of the robot) follows along.
import type { Topic } from "./transport.ts"
import { isDepthTopic } from "./video.ts"

export const isImage = (topic: Topic) => topic.type === "sensor_msgs.Image" || topic.type === "sensor_msgs.CompressedImage"

/** The camera to show first: the profile's preferred names in order, else the first color image, else any image. */
export function pickDefault(preferred: string[], topics: Topic[], exclude: Set<string> = new Set()): Topic | null {
    const images = topics.filter((topic) => isImage(topic) && !exclude.has(topic.key))
    for (const name of preferred) {
        const found = images.find((topic) => topic.name === name)
        if (found) {
            return found
        }
    }
    return images.find((topic) => !isDepthTopic(topic)) ?? images[0] ?? null
}

export interface CameraChoice {
    id: number
    /** the topic key shown */
    key: string
    /** the topic key the viewer picked from the panel's list (shown again whenever it's on the bus) */
    picked?: string
}

/**
 * Panels pointed at what the bus has: a panel's picked topic when it's back, else a panel whose topic isn't on the bus
 * moves to the default camera no other panel shows. Null when nothing changes (or the bus has no images to move to).
 */
export function retargetPanels<T extends CameraChoice>(panels: T[], topics: Topic[], preferred: string[]): T[] | null {
    const onBus = new Set(topics.filter(isImage).map((topic) => topic.key))
    const used = new Set(panels.filter((panel) => onBus.has(panel.key)).map((panel) => panel.key))
    let changed = false
    const next = panels.map((panel) => {
        if (panel.picked && panel.picked !== panel.key && onBus.has(panel.picked)) {
            changed = true
            used.add(panel.picked)
            return { ...panel, key: panel.picked }
        }
        if (onBus.has(panel.key)) {
            return panel
        }
        const fallback = pickDefault(preferred, topics, used)
        if (!fallback) {
            return panel
        }
        changed = true
        used.add(fallback.key)
        return { ...panel, key: fallback.key }
    })
    return changed ? next : null
}
