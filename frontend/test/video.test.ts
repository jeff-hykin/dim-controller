// Camera latency/quality presets (core/videoQuality.ts) reach the bridge as subscription options; a change updates it in place.
import { assertEquals } from "jsr:@std/assert@1"
import { DEPTH_OPTIONS, DEPTH_PREVIEW_OPTIONS, optionChanges, PREVIEW_OPTIONS, streamOptions, VideoSources } from "../src/core/video.ts"
import { loadQuality, presetFor, QUALITY_PRESETS, saveQuality } from "../src/core/videoQuality.ts"
import type { Connection, SubscribeOptions, SubscriptionUpdate } from "../src/core/transport.ts"

function fakeConnection({ refuseUpdates = false } = {}) {
    const subscriptions: { key: string; options: SubscribeOptions; open: boolean; openBefore: number; updates: SubscriptionUpdate[] }[] = []
    const connection = {
        subscribe(key: string, options: SubscribeOptions) {
            const openBefore = subscriptions.filter((other) => other.open).length
            const entry = { key, options, open: true, openBefore, updates: [] as SubscriptionUpdate[] }
            subscriptions.push(entry)
            const stop = () => (entry.open = false)
            return Object.assign(stop, {
                update(changes: SubscriptionUpdate) {
                    if (refuseUpdates) {
                        return Promise.reject(new Error("unknown op updateSubscription"))
                    }
                    entry.updates.push(changes)
                    const options: Record<string, unknown> = { ...entry.options }
                    for (const [name, value] of Object.entries(changes)) {
                        value === null ? delete options[name] : (options[name] = value)
                    }
                    entry.options = options as SubscribeOptions
                    return Promise.resolve()
                },
            })
        },
    }
    return { connection: connection as unknown as Connection, subscriptions }
}

const camera = { key: "dimos/color_image/sensor_msgs.Image", name: "/color_image", type: "sensor_msgs.Image" }
const preset = (id: string) => QUALITY_PRESETS.find((preset) => preset.id === id)!.options

Deno.test("a color camera subscribes with the viewer's preset; changing it updates the running subscription and is remembered", async () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    const source = sources.acquire(camera)
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_image" }, "balanced: the gateway's defaults at the camera's rate")
    sources.setQuality(camera, "latency")
    await Promise.resolve()
    assertEquals(subscriptions.length, 1, "no resubscribe: the same subscription takes the preset")
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_image", ...preset("latency") })
    assertEquals(source.quality.get().quality, "latency")
    assertEquals(loadQuality(camera.key), "latency")
    sources.setQuality(camera, "quality")
    await Promise.resolve()
    // what Low latency set and High quality doesn't goes back to the gateway's default
    assertEquals(subscriptions[0].updates[1].maxResolution, null)
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_image", ...preset("quality") })
    assertEquals(subscriptions[0].options.playoutDelay, [100, 400], "High quality buffers for smooth playout")
    sources.setQuality(camera, "balanced")
    await Promise.resolve()
    assertEquals(subscriptions[0].options, { delivery: "latest", encoding: "dimos_lcm_image" })
    assertEquals(subscriptions[0].updates[2].playoutDelay, null)
    assertEquals(subscriptions.length, 1)
    sources.setQuality(camera, "quality")
    sources.release(camera)
    assertEquals(subscriptions.every((entry) => !entry.open), true)
    // the next viewer session starts on the saved preset
    const again = new VideoSources(connection)
    again.acquire(camera)
    assertEquals(subscriptions.at(-1)!.options.maxBitrate, 6_000_000)
    assertEquals(subscriptions.every((entry) => entry.options.maxHz === undefined), true)
})

Deno.test("a gateway that refuses the update gets a new subscription with the preset", async () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection({ refuseUpdates: true })
    const sources = new VideoSources(connection)
    sources.acquire(camera)
    sources.setQuality(camera, "latency")
    await new Promise((resolve) => setTimeout(resolve, 0))
    assertEquals(subscriptions.map((entry) => entry.open), [false, true])
    assertEquals(subscriptions[1].openBefore, 0, "the old subscription closes first (the client gives the new one a fresh transceiver)")
    assertEquals(subscriptions[1].options, { delivery: "latest", ...preset("latency"), encoding: "dimos_lcm_image" })
})

Deno.test("optionChanges: the new preset's options, null for the ones only the old set", () => {
    assertEquals(optionChanges(presetFor("latency").options, presetFor("balanced").options), { maxResolution: null, qualityToHzTradeoff: null })
    assertEquals(optionChanges(presetFor("balanced").options, presetFor("latency").options), preset("latency"))
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

// Cameras in 3D: the 3D view's projection and a camera panel share one subscription per topic. Alone, the 3D view
// takes a small, slow stream; a panel opening over it switches that same subscription to the panel's preset, and
// closing it switches back; the last user going stops it.
const depthCamera = { key: "dimos/depth_image/sensor_msgs.Image", name: "/depth_image", type: "sensor_msgs.Image" }

Deno.test("cameras in 3D: alone, the 3D view subscribes small and slow", () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    sources.acquire(camera, "preview")
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options, { delivery: "latest", ...PREVIEW_OPTIONS, encoding: "dimos_lcm_image" })
    assertEquals(subscriptions[0].options.maxHz! <= 5, true)
    sources.release(camera, "preview")
    assertEquals(subscriptions[0].open, false, "setting off or the 3D view collapsed: the preview is dropped")
})

Deno.test("cameras in 3D: a panel opening shares the 3D view's subscription at its preset, closing it goes back to the preview", async () => {
    localStorage.clear()
    saveQuality(camera.key, "quality")
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    const preview = sources.acquire(camera, "preview")
    const viewed = sources.acquire(camera, "view")
    await Promise.resolve()
    assertEquals(viewed, preview, "one source: the 3D view's texture and the panel play the same stream")
    assertEquals(subscriptions.length, 1, "no second subscription")
    assertEquals(subscriptions[0].options, { delivery: "latest", ...preset("quality"), encoding: "dimos_lcm_image" })
    // a preset change while viewed applies to the shared stream
    sources.setQuality(camera, "latency")
    await Promise.resolve()
    assertEquals(subscriptions[0].options, { delivery: "latest", ...preset("latency"), encoding: "dimos_lcm_image" })
    // the panel collapses: back to the preview on the same subscription
    sources.release(camera, "view")
    await Promise.resolve()
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].open, true)
    assertEquals(subscriptions[0].options, { delivery: "latest", ...PREVIEW_OPTIONS, encoding: "dimos_lcm_image" })
    // a preset change while only previewed is remembered for when a panel opens, the preview unchanged
    sources.setQuality(camera, "balanced")
    await Promise.resolve()
    assertEquals(subscriptions[0].options, { delivery: "latest", ...PREVIEW_OPTIONS, encoding: "dimos_lcm_image" })
    sources.release(camera, "preview")
    assertEquals(subscriptions[0].open, false)
})

Deno.test("cameras in 3D: a panel already open keeps its stream when the 3D view joins and leaves", async () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    sources.acquire(camera, "view")
    sources.acquire(camera, "preview")
    sources.release(camera, "preview")
    await Promise.resolve()
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].updates, [], "the panel's stream never changes for the 3D view")
    assertEquals(subscriptions[0].open, true)
    // a release by a user that holds none changes nothing
    sources.release(camera, "preview")
    assertEquals(subscriptions[0].open, true)
    sources.release(camera, "view")
    assertEquals(subscriptions[0].open, false)
})

Deno.test("cameras in 3D: a depth camera previews at a few Hz, full rate while its panel is open", async () => {
    localStorage.clear()
    const { connection, subscriptions } = fakeConnection()
    const sources = new VideoSources(connection)
    sources.acquire(depthCamera, "preview")
    assertEquals(subscriptions[0].options.maxHz, DEPTH_PREVIEW_OPTIONS.maxHz)
    sources.acquire(depthCamera, "view")
    await Promise.resolve()
    assertEquals(subscriptions.length, 1)
    assertEquals(subscriptions[0].options.maxHz, DEPTH_OPTIONS.maxHz)
})

Deno.test("streamOptions: any panel on screen means the full stream", () => {
    assertEquals(streamOptions(false, { view: 0, preview: 1 }, "quality"), PREVIEW_OPTIONS)
    assertEquals(streamOptions(false, { view: 1, preview: 1 }, "quality"), preset("quality"))
    assertEquals(streamOptions(true, { view: 0, preview: 2 }, "balanced"), DEPTH_PREVIEW_OPTIONS)
    assertEquals(streamOptions(true, { view: 1, preview: 0 }, "balanced"), DEPTH_OPTIONS)
})
