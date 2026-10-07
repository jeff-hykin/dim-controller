// Camera quality presets: the quality-vs-framerate tradeoff, applied at the source. Each preset is bridge subscription
// options (zenoh-gateway's video policy: maxHz, maxResolution, minResolutionScale, minQuality, qualityToHzTradeoff), so
// the bridge encodes a smaller picture or sends fewer frames; nothing is thrown away in the browser.
// The choice is per viewer (a phone on cellular wants Smooth, a desktop on the LAN Sharp): localStorage, not the
// backend's shared settings.
import type { SubscribeOptions } from "./transport.ts"

export type VideoQuality = "auto" | "smooth" | "balanced" | "sharp"

export interface QualityPreset {
    id: VideoQuality
    label: string
    about: string
    options: SubscribeOptions
}

export const QUALITY_PRESETS: QualityPreset[] = [
    { id: "auto", label: "Auto", about: "the gateway picks size and rate for the bandwidth (up to 30 fps)", options: { maxHz: 30 } },
    {
        id: "smooth",
        label: "Smooth",
        about: "low-res (fits 640×360), up to 30 fps; keeps the rate when bandwidth is short",
        options: { maxHz: 30, maxResolution: [640, 360], qualityToHzTradeoff: 1 },
    },
    {
        id: "balanced",
        label: "Balanced",
        about: "up to 720p, up to 20 fps",
        options: { maxHz: 20, maxResolution: [1280, 720], qualityToHzTradeoff: 0.5 },
    },
    {
        id: "sharp",
        label: "Sharp",
        about: "full resolution, up to 10 fps; drops frames before detail",
        options: { maxHz: 10, minResolutionScale: 1, minQuality: 0.6, qualityToHzTradeoff: 0 },
    },
]

export const presetFor = (id: string | undefined): QualityPreset => QUALITY_PRESETS.find((preset) => preset.id === id) ?? QUALITY_PRESETS[0]

const QUALITY_KEY = "lv.video.quality"

/** This viewer's preset for a topic key (Auto when unset, or storage is unavailable). */
export function loadQuality(topicKey: string): VideoQuality {
    return presetFor(readLocal<Record<string, string>>(QUALITY_KEY, {})[topicKey]).id
}

export function saveQuality(topicKey: string, quality: VideoQuality) {
    writeLocal(QUALITY_KEY, { ...readLocal<Record<string, string>>(QUALITY_KEY, {}), [topicKey]: quality })
}

/** localStorage JSON, or the fallback (private windows, blocked storage and tests throw or return nothing). */
export function readLocal<T>(key: string, fallback: T): T {
    try {
        const raw = globalThis.localStorage?.getItem(key)
        return raw ? JSON.parse(raw) as T : fallback
    } catch {
        return fallback
    }
}

export function writeLocal(key: string, value: unknown) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value))
    } catch {
        // storage unavailable: the choice lasts for this page only
    }
}
