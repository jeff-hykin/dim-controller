// Camera quality presets (core/videoQuality.ts) reach the bridge as subscription options, and a change resubscribes.
import { assertEquals } from "jsr:@std/assert@1"
import { VideoSources } from "../src/core/video.ts"
import { loadQuality, QUALITY_PRESETS } from "../src/core/videoQuality.ts"
import type { Connection, SubscribeOptions } from "../src/core/transport.ts"

function fakeConnection() {
    const subscriptions: { key: string; options: SubscribeOptions; open: boolean }[] = []
    const connection = {
        subscribe(key: string, options: SubscribeOptions) {
            const entry = { key, options, open: true }
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
    assertEquals(subscriptions[0].options.maxHz, 30, "auto: what it always was")
    assertEquals(subscriptions[0].options.encoding, "dimos_lcm_image")
    sources.setQuality(camera, "smooth")
    assertEquals(subscriptions[0].open, false)
    const smooth = QUALITY_PRESETS.find((preset) => preset.id === "smooth")!.options
    assertEquals(subscriptions[1].options, { delivery: "latest", ...smooth, encoding: "dimos_lcm_image" })
    assertEquals(source.quality.get().quality, "smooth")
    assertEquals(loadQuality(camera.key), "smooth")
    sources.setQuality(camera, "sharp")
    assertEquals(subscriptions[2].options.minResolutionScale, 1)
    assertEquals(subscriptions[2].options.qualityToHzTradeoff, 0)
    sources.release(camera)
    assertEquals(subscriptions.every((entry) => !entry.open), true)
    // the next viewer session starts on the saved preset
    const again = new VideoSources(connection)
    again.acquire(camera)
    assertEquals(subscriptions.at(-1)!.options.maxHz, 10)
})

Deno.test("depth stays lossless whatever the preset", () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    const depth = { key: "dimos/depth_image/sensor_msgs.Image", name: "/depth_image", type: "sensor_msgs.Image" }
    sources.acquire(depth)
    sources.setQuality(depth, "smooth")
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options.encoding, "dimos_lcm_depth")
})
