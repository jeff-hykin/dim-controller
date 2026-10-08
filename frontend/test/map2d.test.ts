// The 2D map's model: the north-up view, grid and cloud images, the trail, and which topic it draws.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import {
    chooseMapTopic,
    chooseOverlay,
    fitView,
    heatLut,
    isValidView,
    MIN_FIT_SPAN,
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
import { parseKey, rememberTopics, type Topic } from "../src/core/transport.ts"
import { clampPanelBox, startPanelDrag } from "../src/ui/panelDrag.ts"

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
    const view = fitView([-10, 0, 10, 5], 200, 200)!
    assertEquals([view.centerX, view.centerY], [0, 2.5])
    assert(view.metersPerPixel >= 0.1)
})

Deno.test("fit with empty or degenerate data never makes a view that blanks the map", () => {
    // no data (the empty box a min/max scan of nothing leaves), NaN, a reversed box: no view, the old one stays
    assertEquals(fitView([Infinity, Infinity, -Infinity, -Infinity], 300, 300), null)
    assertEquals(fitView([NaN, 0, 1, 1], 300, 300), null)
    assertEquals(fitView([1, 1, 0, 0], 300, 300), null)
    // a single point: centered on it, but not zoomed in past a few meters across
    const point = fitView([3, 4, 3, 4], 300, 300)!
    assertEquals([point.centerX, point.centerY], [3, 4])
    assert(point.metersPerPixel * 300 >= MIN_FIT_SPAN)
    // a canvas with no size yet still gives a usable view
    assert(isValidView(fitView([0, 0, 10, 10], 0, 0)))
    assert(!isValidView({ centerX: NaN, centerY: 0, metersPerPixel: 0.05 }))
    assert(!isValidView({ centerX: 0, centerY: 0, metersPerPixel: 0 }))
    assert(!isValidView(null))
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
    const lut = heatLut([[0, 0, 0, 255], [255, 255, 255, 255]])
    const cloud = projectCloud(new Float32Array([0, 0, 0, 0.02, 0.02, 2, 1, 1, 0]), identity, lut, 0.5)!
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

Deno.test("heat ramp: cold to hot, never black (the floor shows on a dark background)", () => {
    const lut = heatLut()
    const brightness = (index: number) => lut[index * 4] + lut[index * 4 + 1] + lut[index * 4 + 2]
    assert(brightness(0) > 100)
    assert(brightness(255) > brightness(128) && brightness(128) > brightness(0))
    assertEquals(lut[3], 255)
})

Deno.test("layers: the global map (a cloud) is the base, a costmap is an overlay only when picked", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2")
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2")
    const costmap = topic("/global_costmap", "nav_msgs.OccupancyGrid")
    const map = topic("/map", "nav_msgs.OccupancyGrid")
    // the Go2 sim's bus: the global map, not the costmap
    assertEquals(chooseMapTopic([lidar, globalMap, costmap], "")?.name, "/global_map")
    assertEquals(chooseMapTopic([lidar, costmap, map], "")?.name, "/lidar")
    assertEquals(chooseMapTopic([costmap, map], "")?.name, "/map")
    assertEquals(chooseMapTopic([lidar, costmap], costmap.key)?.name, "/global_costmap")
    assertEquals(chooseMapTopic([globalMap], lidar.key)?.name, "/global_map")
    assertEquals(chooseMapTopic([topic("/odom", "geometry_msgs.PoseStamped")], ""), null)
    // the overlay: off by default, the picked grid when it's on the bus and isn't already the base
    const base = chooseMapTopic([globalMap, costmap], "")
    assertEquals(chooseOverlay([globalMap, costmap], "", base), null)
    assertEquals(chooseOverlay([globalMap, costmap], costmap.key, base)?.name, "/global_costmap")
    assertEquals(chooseOverlay([globalMap], costmap.key, base), null)
    assertEquals(chooseOverlay([globalMap, costmap], globalMap.key, base), null)
    assertEquals(chooseOverlay([costmap], costmap.key, costmap), null)
})

Deno.test("discovery: a slow topic that misses a round stays listed until it's been gone a while", () => {
    const lidar = topic("/lidar", "sensor_msgs.PointCloud2")
    const globalMap = topic("/global_map", "sensor_msgs.PointCloud2")
    const lastSeen = new Map()
    assertEquals(rememberTopics(lastSeen, [lidar, globalMap], 0, 10_000).map((t) => t.name), ["/global_map", "/lidar"])
    // the 0.5 Hz map wasn't caught by this round's probe: still there (the panel doesn't flip to /lidar and wipe it)
    assertEquals(rememberTopics(lastSeen, [lidar], 2_000, 10_000).map((t) => t.name), ["/global_map", "/lidar"])
    // gone for longer than the window: dropped
    assertEquals(rememberTopics(lastSeen, [lidar], 12_001, 10_000).map((t) => t.name), ["/lidar"])
})

Deno.test("panel box: a remembered position or size can never put the panel out of reach", () => {
    const defaults = { x: -1, y: -1, width: 320, height: 353 }
    const minimum = { width: 200, height: 150 }
    const screen = { width: 1400, height: 900 }
    assertEquals(clampPanelBox({ x: 100, y: 200, width: 400, height: 300 }, defaults, screen, minimum), { x: 100, y: 200, width: 400, height: 300 })
    // off the right / bottom (a bigger window before), above the top bar, too small, too big
    const off = clampPanelBox({ x: 5000, y: 5000, width: 0, height: 1e6 }, defaults, screen, minimum)
    assert(off.x + 80 <= screen.width && off.y + 40 <= screen.height)
    assertEquals([off.width, off.height], [200, 900 - 48 - 8])
    assertEquals(clampPanelBox({ x: 10, y: 0 }, defaults, screen, minimum).y, 48)
    // NaN / null / strings from a broken entry: the defaults
    assertEquals(clampPanelBox({ x: NaN, y: null as never, width: "wide" as never }, defaults, screen, minimum), { x: -1, y: -1, width: 320, height: 353 })
    // a window with no size yet (a hidden frame) still gives a real box
    const hidden = clampPanelBox({ x: 300, y: 300 }, defaults, { width: 0, height: 0 }, minimum)
    assert(Number.isFinite(hidden.x) && hidden.width >= 200)
})

Deno.test("a header drag leaves no inline right/bottom behind (they'd squash the panel to nothing in fullscreen)", () => {
    const globals = globalThis as unknown as Record<string, number>
    const before = [globals.innerWidth, globals.innerHeight]
    globals.innerWidth = 1400
    globals.innerHeight = 900
    try {
        let box = { left: 10, top: 108 }
        const style: Record<string, string> = {}
        const element = { style, getBoundingClientRect: () => box } as unknown as HTMLElement
        let dropped: number[] = []
        startPanelDrag({ clientX: 20, clientY: 115 } as never, element, (x, y) => (dropped = [x, y]))
        globalThis.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 120, clientY: 215 }))
        assertEquals([style.left, style.top, style.right, style.bottom], ["110px", "208px", "auto", "auto"])
        box = { left: 110, top: 208 }
        globalThis.dispatchEvent(new Event("pointerup"))
        assertEquals([style.right, style.bottom], ["", ""])
        assertEquals(dropped, [110, 208])
        // a click without a move (half of a double-click) changes nothing
        dropped = []
        startPanelDrag({ clientX: 20, clientY: 115 } as never, element, (x, y) => (dropped = [x, y]))
        globalThis.dispatchEvent(new Event("pointerup"))
        assertEquals(dropped, [])
    } finally {
        globals.innerWidth = before[0]
        globals.innerHeight = before[1]
    }
})
