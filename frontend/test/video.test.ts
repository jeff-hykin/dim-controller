// Camera latency/quality presets (core/videoQuality.ts) reach the bridge as subscription options, and a change resubscribes.
import { assertEquals } from "jsr:@std/assert@1"
import { VideoSources } from "../src/core/video.ts"
import { loadQuality, presetFor, QUALITY_PRESETS, saveQuality } from "../src/core/videoQuality.ts"
import type { Connection, SubscribeOptions } from "../src/core/transport.ts"

function fakeConnection() {
    const subscriptions: { key: string; options: SubscribeOptions; open: boolean; openBefore: number }[] = []
    const connection = {
        subscribe(key: string, options: SubscribeOptions) {
            const entry = { key, options, open: true, openBefore: subscriptions.filter((other) => other.open).length }
            subscriptions.push(entry)
            return () => (entry.open = false)
        },
    }
    return { connection: connection as unknown as Connection, subscriptions }
}

const camera = { key: "dimos/color_image/sensor_msgs.Image", name: "/color_image", type: "sensor_msgs.Image" }

Deno.test("a color camera subscribes with the viewer's preset; changing it reopens the subscription and is remembered", () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    const source = sources.acquire(camera)
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_image" }, "balanced: the gateway's defaults at the camera's rate")
    sources.setQuality(camera, "latency")
    assertEquals(subscriptions[0].open, false)
    assertEquals(subscriptions[1].openBefore, 1, "the new subscription opens before the old one closes (else the gateway may refuse the reused track)")
    const latency = QUALITY_PRESETS.find((preset) => preset.id === "latency")!.options
    assertEquals(subscriptions[1].options, { delivery: "latest", ...latency, encoding: "dimos_lcm_image" })
    assertEquals(source.quality.get().quality, "latency")
    assertEquals(loadQuality(camera.key), "latency")
    sources.setQuality(camera, "quality")
    assertEquals(subscriptions[2].options.minResolutionScale, 1)
    assertEquals(subscriptions[2].options.qualityToHzTradeoff, 0)
    sources.release(camera)
    assertEquals(subscriptions.every((entry) => !entry.open), true)
    // the next viewer session starts on the saved preset
    const again = new VideoSources(connection)
    again.acquire(camera)
    assertEquals(subscriptions.at(-1)!.options.maxBitrate, 6_000_000)
    assertEquals(subscriptions.every((entry) => entry.options.maxHz === undefined), true, "maxHz would reach the encoder as its frame rate")
})

Deno.test("a saved preset from before the latency/quality axis maps to its nearest", () => {
    localStorage.clear()
    for (const [old, now] of [["auto", "balanced"], ["smooth", "latency"], ["sharp", "quality"], ["nonsense", "balanced"]]) {
        saveQuality(camera.key, old as never)
        assertEquals(loadQuality(camera.key), now)
    }
    assertEquals(presetFor(undefined).id, "balanced")
})

Deno.test("depth stays lossless whatever the preset", () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    const depth = { key: "dimos/depth_image/sensor_msgs.Image", name: "/depth_image", type: "sensor_msgs.Image" }
    sources.acquire(depth)
    sources.setQuality(depth, "latency")
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options.encoding, "dimos_lcm_depth")
})
