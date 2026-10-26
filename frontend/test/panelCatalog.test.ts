// The settings drawer's counts (ui/panelCatalog.ts): what each kind of panel could show that nothing shows, and the
// Settings button's number (never-used kinds only).
import { assertEquals } from "jsr:@std/assert@1"
import { kindOf, settingsBadge, unshownStreams } from "../src/ui/panelCatalog.ts"
import { parseKey, type Topic } from "../src/core/transport.ts"

const topic = (name: string, type: string): Topic => parseKey(`dimos/${name}/${type}`)!
const topics = [
    topic("color_image", "sensor_msgs.Image"),
    topic("depth", "sensor_msgs.Image"),
    topic("lidar", "sensor_msgs.PointCloud2"),
    topic("costmap", "nav_msgs.OccupancyGrid"),
    topic("speed", "std_msgs.Float32"),
    topic("odom", "nav_msgs.Odometry"),
]
const none = { open: new Set<never>(), cameraKeys: new Set<string>(), plottedKeys: new Set<string>() }

Deno.test("kindOf: each panel's kind", () => {
    assertEquals(["camera:3", "plot:1", "scene", "map", "settings", "tf"].map(kindOf), ["camera", "plot", "scene", "map", "settings", null])
})

Deno.test("unshownStreams: images no camera shows, clouds and maps while their panel is closed, one-number topics no plot reads", () => {
    assertEquals(unshownStreams("camera", topics, none).length, 2)
    assertEquals(unshownStreams("camera", topics, { ...none, cameraKeys: new Set([topics[0].key]) }).map((one) => one.name), ["/depth"])
    assertEquals(unshownStreams("scene", topics, none).map((one) => one.name), ["/lidar"])
    assertEquals(unshownStreams("scene", topics, { ...none, open: new Set(["scene"]) }), [])
    assertEquals(unshownStreams("map", topics, none).map((one) => one.name), ["/costmap"])
    assertEquals(unshownStreams("plot", topics, none).map((one) => one.name), ["/speed"])
    assertEquals(unshownStreams("plot", topics, { ...none, plottedKeys: new Set([topics[4].key]) }), [])
    assertEquals(unshownStreams("settings", topics, none), [])
})

Deno.test("settingsBadge: only kinds never used count", () => {
    assertEquals(settingsBadge(topics, none, new Set()), 5)
    assertEquals(settingsBadge(topics, none, new Set(["camera"])), 3)
    assertEquals(settingsBadge(topics, none, new Set(["camera", "scene", "map", "plot", "settings"])), 0)
})
