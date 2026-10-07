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

export interface CameraTab {
    topic: Topic
    /** the name without the path every camera shares, front and back (full name in the tab's tooltip) */
    label: string
    depth: boolean
}

/** Every image topic on the bus as a tab, color first then depth, by name, labeled by what tells them apart. */
export function cameraTabs(topics: Topic[]): CameraTab[] {
    const images = topics.filter(isImage).sort((a, b) => Number(isDepthTopic(a)) - Number(isDepthTopic(b)) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
    const split = images.map((topic) => topic.name.split("/").filter(Boolean))
    let shared = 0
    if (split.length > 1) {
        while (split.every((parts) => shared < parts.length - 1 && parts[shared] === split[0][shared])) {
            shared++
        }
    }
    // and the tail they all end with (/spot/<side>/image → <side>)
    let tail = 0
    if (split.length > 1) {
        const at = (parts: string[]) => parts[parts.length - 1 - tail]
        while (split.every((parts) => parts.length - shared - tail > 1 && at(parts) === at(split[0]))) {
            tail++
        }
    }
    const labels = split.map((parts) => parts.slice(shared, parts.length - tail).join("/"))
    return images.map((topic, index) => {
        // the same name under two types (Image and CompressedImage): the type tells them apart
        const twin = labels.some((label, other) => other !== index && label === labels[index])
        return { topic, label: twin ? `${labels[index]} (${topic.type.split(".").pop()})` : labels[index], depth: isDepthTopic(topic) }
    })
}
