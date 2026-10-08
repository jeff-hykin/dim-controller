// The 2D map's model: the north-up view, grid and cloud images, the trail, and which topic it draws.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import {
    chooseMapTopic,
    fitView,
    floorPose,
    gridLut,
    gridPixels,
    type MapView,
    niceLength,
    pan,
    projectCloud,
    screenToWorld,
    Trail,
    worldToScreen,
    zoomAt,
} from "../src/core/map2d.ts"
import { parseKey, type Topic } from "../src/core/transport.ts"

const topic = (name: string, type: string): Topic => parseKey(`dimos${name}/${type}`)!

Deno.test("north-up: +x is right, +y is up, the center is the middle", () => {
    const view: MapView = { centerX: 2, centerY: 3, metersPerPixel: 0.1 }
    assertEquals(worldToScreen(view, 200, 100, 2, 3), [100, 50])
    assertEquals(worldToScreen(view, 200, 100, 3, 3), [110, 50])
    assertEquals(worldToScreen(view, 200, 100, 2, 4), [100, 40])
    const [x, y] = screenToWorld(view, 200, 100, 110, 40)
    assertAlmostEquals(x, 3)
    assertAlmostEquals(y, 4)
})

Deno.test("zooming keeps the point under the cursor; panning moves the content with the drag", () => {
    const view: MapView = { centerX: 0, centerY: 0, metersPerPixel: 0.1 }
    const under = screenToWorld(view, 300, 200, 40, 170)
    const zoomed = zoomAt(view, 300, 200, 40, 170, 2)
    assertAlmostEquals(zoomed.metersPerPixel, 0.05)
    const after = screenToWorld(zoomed, 300, 200, 40, 170)
    assertAlmostEquals(after[0], under[0])
    assertAlmostEquals(after[1], under[1])
    // dragging right by 10 px: what was at the center is now 10 px right of it
    const moved = pan(view, 10, 0)
    assertEquals(worldToScreen(moved, 300, 200, 0, 0), [160, 100])
    // zoom stays within its limits
    assertEquals(zoomAt(view, 300, 200, 0, 0, 1e9).metersPerPixel, 0.002)
})

Deno.test("fit shows the whole box", () => {
    const view = fitView([-10, 0, 10, 5], 200, 200)
    assertEquals([view.centerX, view.centerY], [0, 2.5])
    assert(view.metersPerPixel >= 0.1)
})

Deno.test("a pose seen from above: position and yaw", () => {
    const yaw = 0.7
    // column-major rotation about z by yaw, translated to (1, 2, 3)
    const elements = [Math.cos(yaw), Math.sin(yaw), 0, 0, -Math.sin(yaw), Math.cos(yaw), 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]
    const pose = floorPose(elements)
    assertEquals([pose.x, pose.y], [1, 2])
    assertAlmostEquals(pose.yaw, yaw)
})

Deno.test("scale bar lengths are 1/2/5 × 10^n", () => {
    assertEquals(niceLength(7), 5)
    assertEquals(niceLength(3), 2)
    assertEquals(niceLength(1.5), 1)
    assertAlmostEquals(niceLength(0.3), 0.2)
})

Deno.test("grid cells: unknown clear, free, cost between low and high, lethal", () => {
    const lut = gridLut({ free: [10, 10, 10, 255], low: [0, 0, 100, 255], high: [0, 0, 200, 255], lethal: [255, 255, 255, 255], unknown: [0, 0, 0, 0] })
    const pixels = gridPixels(new Int8Array([-1, 0, 50, 100]), 4, 1, lut)
    assertEquals([...pixels.slice(0, 4)], [0, 0, 0, 0])
    assertEquals([...pixels.slice(4, 8)], [10, 10, 10, 255])
    assert(pixels[10] > 100 && pixels[10] < 200)
    assertEquals([...pixels.slice(12, 16)], [255, 255, 255, 255])
})

Deno.test("a cloud from above: placed by its transform, the highest point colors a cell", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]
    const cloud = projectCloud(new Float32Array([0, 0, 0, 0.02, 0.02, 2, 1, 1, 0]), identity, [0, 0, 0, 255], [255, 255, 255, 255], 0.5)!
    assertEquals([cloud.originX, cloud.originY, cloud.cell], [5, 0, 0.5])
    assertEquals([cloud.width, cloud.height], [3, 3])
    // cell (0,0) holds z=0 and z=2: the tall one wins
    assertEquals(cloud.pixels[0], 255)
    // (2,2) holds the floor point; empty cells stay clear
    assertEquals(cloud.pixels[(2 * 3 + 2) * 4 + 3], 255)
    assertEquals(cloud.pixels[(1 * 3 + 0) * 4 + 3], 0)
})

Deno.test("trail: skips jitter, breaks at a jump, stays bounded", () => {
    const trail = new Trail(0.05, 2, 10)
    assert(trail.push(0, 0))
    assert(!trail.push(0.01, 0))
    assert(trail.push(0.1, 0))
    trail.push(10, 0)
    assert(Number.isNaN(trail.points[4]))
    for (let index = 0; index < 50; index++) {
        trail.push(10 + index * 0.1, 0)
    }
    assert(trail.points.length <= 20)
})

Deno.test("topic choice: a grid before a cloud, a map before a costmap, the pick when on the bus", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2")
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2")
    const costmap = topic("/global_costmap", "nav_msgs.OccupancyGrid")
    const map = topic("/map", "nav_msgs.OccupancyGrid")
    assertEquals(chooseMapTopic([lidar, globalMap, costmap], "")?.name, "/global_costmap")
    assertEquals(chooseMapTopic([lidar, costmap, map], "")?.name, "/map")
    assertEquals(chooseMapTopic([lidar, globalMap], "")?.name, "/global_map")
    assertEquals(chooseMapTopic([lidar, costmap], lidar.key)?.name, "/lidar")
    assertEquals(chooseMapTopic([costmap], lidar.key)?.name, "/global_costmap")
    assertEquals(chooseMapTopic([topic("/odom", "geometry_msgs.PoseStamped")], ""), null)
})
