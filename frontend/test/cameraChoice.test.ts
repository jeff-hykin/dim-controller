// A saved camera panel follows the bus: off-bus topics move to the default camera, the viewer's pick comes back.
import { assertEquals } from "jsr:@std/assert@1"
import { pickDefault, retargetPanels } from "../src/core/cameraChoice.ts"

const color = { key: "dimos/color_image/sensor_msgs.Image", name: "/color_image", type: "sensor_msgs.Image" }
const compressed = { key: "dimos/image/sensor_msgs.CompressedImage", name: "/image", type: "sensor_msgs.CompressedImage" }
const depth = { key: "dimos/depth_image/sensor_msgs.Image", name: "/depth_image", type: "sensor_msgs.Image" }
const lidar = { key: "dimos/lidar/sensor_msgs.PointCloud2", name: "/lidar", type: "sensor_msgs.PointCloud2" }
const preferred = ["/color_image", "/camera/color", "/image"]

Deno.test("a panel saved on a topic the bus doesn't have moves to the preferred camera (the sim's /color_image)", () => {
    const panels = [{ id: 1, key: compressed.key }]
    assertEquals(retargetPanels(panels, [lidar, color], preferred), [{ id: 1, key: color.key }])
})

Deno.test("a panel whose topic is on the bus stays", () => {
    assertEquals(retargetPanels([{ id: 1, key: compressed.key }], [color, compressed], preferred), null)
})

Deno.test("no images on the bus: the panel keeps its topic", () => {
    assertEquals(retargetPanels([{ id: 1, key: compressed.key }], [lidar], preferred), null)
})

Deno.test("two off-bus panels take different cameras", () => {
    const panels = [{ id: 1, key: "gone/a" }, { id: 2, key: "gone/b" }]
    assertEquals(retargetPanels(panels, [depth, color], preferred), [{ id: 1, key: color.key }, { id: 2, key: depth.key }])
})

Deno.test("a fallback doesn't duplicate a panel already showing that camera", () => {
    const panels = [{ id: 1, key: color.key }, { id: 2, key: "gone/a" }]
    assertEquals(retargetPanels(panels, [color, compressed], preferred), [{ id: 1, key: color.key }, { id: 2, key: compressed.key }])
})

Deno.test("the viewer's pick comes back when its topic does", () => {
    const panels = [{ id: 1, key: color.key, picked: compressed.key }]
    assertEquals(retargetPanels(panels, [color], preferred), null)
    assertEquals(retargetPanels(panels, [color, compressed], preferred), [{ id: 1, key: compressed.key, picked: compressed.key }])
})

Deno.test("pickDefault: preferred order, then a color image over depth", () => {
    assertEquals(pickDefault(preferred, [compressed, color]), color)
    assertEquals(pickDefault([], [depth, compressed]), compressed)
    assertEquals(pickDefault(preferred, [lidar]), null)
})
