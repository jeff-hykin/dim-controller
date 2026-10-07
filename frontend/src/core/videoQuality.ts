// Camera presets: the latency-vs-quality tradeoff, per camera and per viewer, as bridge subscription options
// (zenoh-gateway's video policy: maxHz, maxResolution, maxBitrate, minResolutionScale, minQuality, qualityToHzTradeoff):
// the gateway encodes a smaller picture at fewer bits (each frame is fewer packets: on the wire, decoded and on screen
// sooner, and a squeezed link keeps the rate) or the full picture at more bits (dropping frames, not detail, when short).
// The browser side has no knob: the gateway marks every video packet playout-delay 0/0, which overrides the receiver's
// jitterBufferTarget, so frames always show the moment they decode (measured 2026-10-07: target 250 ms, buffer 0 ms).
// The choice is per viewer (a phone on cellular wants low latency, a desktop on the LAN quality): localStorage, not the
// backend's shared settings.
import type { SubscribeOptions } from "./transport.ts"

export type VideoQuality = "latency" | "balanced" | "quality"

export interface QualityPreset {
    id: VideoQuality
    label: string
    about: string
    options: SubscribeOptions
}

export const QUALITY_PRESETS: QualityPreset[] = [
    {
        id: "latency",
        label: "Low latency",
        about: "fits 640×360, at most 2 Mbit/s, up to 30 fps; small frames arrive and decode soonest, the rate kept when the link is squeezed",
        options: { maxHz: 30, maxResolution: [640, 360], maxBitrate: 2_000_000, qualityToHzTradeoff: 1 },
    },
    {
        id: "balanced",
        label: "Balanced",
        about: "the gateway picks size and bitrate for the bandwidth, up to 30 fps",
        options: { maxHz: 30 },
    },
    {
        id: "quality",
        label: "High quality",
        about: "full size, never shrunk, at least 60% quality; drops frames before detail when the link is squeezed",
        options: { maxHz: 30, minResolutionScale: 1, minQuality: 0.6, qualityToHzTradeoff: 0 },
    },
]

/** presets before 2026-10-07 (a size-vs-rate choice) → the nearest one now */
const RENAMED: Record<string, VideoQuality> = { auto: "balanced", smooth: "latency", sharp: "quality" }

export const presetFor = (id: string | undefined): QualityPreset =>
    QUALITY_PRESETS.find((preset) => preset.id === (RENAMED[id ?? ""] ?? id)) ?? QUALITY_PRESETS[1]

const QUALITY_KEY = "lv.video.quality"

/** This viewer's preset for a topic key (Balanced when unset, or storage is unavailable). */
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
