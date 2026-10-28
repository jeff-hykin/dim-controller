// The panel system (ui/workspace.ts): the default arrangement, a saved one made safe, the boxes at a desktop's and a
// phone's size (edge to edge), where a dragged header snaps (rails, the main view, floating against edges), the panel
// actions, a collapse giving its height to its neighbours, the splitters, and the arrangement surviving a reload.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1"
import {
    type Arrangement,
    defaultArrangement,
    dropTarget,
    FIXED_PANELS,
    type Frame,
    layoutWorkspace,
    loadArrangement,
    locate,
    closePanel,
    movePanel,
    normalizeArrangement,
    PANEL_HEAD,
    phonePanel,
    placePanel,
    popOut,
    type Rect,
    resizeRail,
    resizeSplit,
    saveArrangement,
    showPanel,
    snapBox,
    SNAP_PX,
    SPLIT_SHARE,
    splitZones,
    toggleCollapsed,
    workspace,
    WORKSPACE_KEY,
} from "../src/ui/workspace.ts"

const IDS = ["camera:1", ...FIXED_PANELS]
/** every panel open, each at home (a saved arrangement that closed nothing) */
const opened = (ids = IDS) => normalizeArrangement({}, ids)
const desktop: Frame = { width: 1440, height: 900, top: 44, bottom: 900 - 64, mobile: false }
const phone: Frame = { width: 390, height: 844, top: 48, bottom: 520, mobile: true }
const shown = { hide: [] }

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const within = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
const center = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

Deno.test("first visit: every fixed panel closed (an empty main view), a camera there is the main view", () => {
    const empty = defaultArrangement(FIXED_PANELS)
    assertEquals([empty.stage, empty.left, empty.right, empty.floating], [null, [], [], []])
    assertEquals(empty.closed.sort(), [...FIXED_PANELS].sort())
    const withCamera = defaultArrangement(IDS)
    assertEquals(withCamera.stage, "camera:1")
    assertEquals([withCamera.left, withCamera.right], [[], []])
})

Deno.test("open: the camera is the main view, map and 3D on the left, settings on the right (TF folded)", () => {
    const arrangement = opened()
    assertEquals(arrangement.stage, "camera:1")
    assertEquals(arrangement.left, ["map", "scene"])
    assertEquals(arrangement.right, ["settings", "tf"])
    assertEquals(arrangement.collapsed.sort(), ["tf"])
    assertEquals(arrangement.floating, [])
    assertEquals(arrangement.closed, [])
})

Deno.test("close and reopen: a fixed panel is remembered closed, a camera or plot just leaves; show and place reopen", () => {
    const closed = closePanel(opened(), "map")
    assertEquals(locate(closed, "map"), null)
    assertEquals(closed.closed, ["map"])
    // it stays closed across a reload's normalizing
    assertEquals(locate(normalizeArrangement(closed, IDS), "map"), null)
    const shownAgain = showPanel(closed, "map")
    assertEquals([locate(shownAgain, "map")?.zone, shownAgain.closed], ["left", []])
    const camera = closePanel(opened(), "camera:1")
    assertEquals([camera.stage, camera.closed], [null, []])
    // placed into an empty side: an uneven split, the side takes SPLIT_SHARE of the width
    const empty = defaultArrangement(IDS)
    const placed = placePanel(empty, "scene", { zone: "right", index: 0 }, 1440)
    assertEquals([placed.right, placed.closed.includes("scene"), placed.rightWidth], [["scene"], false, Math.round(1440 * SPLIT_SHARE)])
    // onto the main view: the camera there goes to its home side
    const main = placePanel(empty, "map", { zone: "stage" }, 1440)
    assertEquals([main.stage, main.left], ["map", ["camera:1"]])
})

Deno.test("a saved arrangement is made safe: each panel once, unknown ones dropped, missing ones at home, sizes finite", () => {
    const saved = {
        stage: "map",
        left: ["map", "ghost", "scene", "scene"],
        right: [],
        floating: [{ id: "settings", x: 100, y: 120, width: 10, height: NaN }, { id: "tf", x: 300, y: 300, width: 300, height: 200 }],
        closed: ["camera:1", 7],
        collapsed: ["map", "nope"],
        leftWidth: Infinity,
        rightWidth: 10,
        weights: { map: -1, scene: 2 },
    } as unknown as Partial<Arrangement>
    const arrangement = normalizeArrangement(saved, IDS)
    assertEquals(arrangement.stage, "map")
    assertEquals(arrangement.left, ["camera:1", "scene"])
    assertEquals(arrangement.floating.map((box) => box.id), ["tf"])
    // a camera is never "closed" (it leaves its list instead), junk is dropped
    assertEquals(arrangement.closed, [])
    // settings (its box was broken) went home: the right rail
    assert(arrangement.right.includes("settings"))
    // the stage panel is never folded
    assert(!arrangement.collapsed.includes("map"))
    assertEquals([arrangement.leftWidth, arrangement.rightWidth], [320, 220])
    assertEquals(arrangement.weights, { scene: 2 })
    // every known panel exactly once
    const placed = [arrangement.stage, ...arrangement.left, ...arrangement.right, ...arrangement.floating.map((box) => box.id)]
    assertEquals(placed.sort(), [...IDS].sort())
    // garbage is the default
    assertEquals(normalizeArrangement("junk" as never, IDS), defaultArrangement(IDS))
    // a closed panel is in no place
    const closedTf = normalizeArrangement({ ...saved, closed: ["tf"] }, IDS)
    assertEquals(locate(closedTf, "tf"), null)
})

Deno.test("an added camera starts at the top of the left rail; a removed one leaves no gap", () => {
    const withTwo = normalizeArrangement(opened(), [...IDS, "camera:2"])
    assertEquals(withTwo.left[0], "camera:2")
    const without = normalizeArrangement(withTwo, IDS)
    assertEquals(without.left, ["map", "scene"])
})

Deno.test("desktop: the rails and the main view share the space between the strip and the dock edge to edge, nothing overlaps", () => {
    const layout = layoutWorkspace(opened(), desktop, shown)
    const left = layout.rails.left!, right = layout.rails.right!
    assert(within(left, layout.area) && within(right, layout.area) && within(layout.stage, layout.area))
    assert(!overlap(left, layout.stage) && !overlap(right, layout.stage))
    assertEquals(layout.slots["camera:1"].rect, layout.stage)
    const docked = ["map", "scene", "settings", "tf"].map((id) => layout.slots[id].rect)
    for (const [index, rect] of docked.entries()) {
        assert(rect.height >= PANEL_HEAD)
        for (const other of docked.slice(index + 1)) {
            assert(!overlap(rect, other), "rail panels never overlap")
        }
    }
    // folded: just the header; the rest share the rail
    assertEquals(layout.slots.tf.rect.height, PANEL_HEAD)
    assert(layout.slots.tf.collapsed && !layout.slots.settings.collapsed)
    // the stage is wider than both rails together
    assert(layout.stage.width > left.width + right.width)
    // no gaps: the rails touch the window's sides and the main view, the area is the whole space between strip and dock
    assertEquals(layout.area, { x: 0, y: desktop.top, width: desktop.width, height: desktop.bottom - desktop.top })
    assertEquals([left.x, left.x + left.width, layout.stage.x + layout.stage.width, right.x + right.width], [0, layout.stage.x, right.x, desktop.width])
    assertEquals(layout.slots.scene.rect.y, layout.slots.map.rect.y + layout.slots.map.rect.height)
    assertEquals(layout.slots.scene.rect.y + layout.slots.scene.rect.height, left.y + left.height)
})

Deno.test("collapsing a rail panel gives its height to the others in its rail; expanding takes it back", () => {
    const arrangement = opened()
    const before = layoutWorkspace(arrangement, desktop, shown)
    const rail = before.rails.left!
    // the 3D view collapsed: the map above it takes the rail but its header
    const folded = layoutWorkspace(toggleCollapsed(arrangement, "scene"), desktop, shown)
    assertEquals(folded.slots.scene.rect.height, PANEL_HEAD)
    assertEquals(folded.slots.map.rect.height, rail.height - PANEL_HEAD)
    assertEquals(folded.slots.scene.rect.y + PANEL_HEAD, rail.y + rail.height)
    // the map collapsed instead: the 3D view below it takes it
    const top = layoutWorkspace(toggleCollapsed(arrangement, "map"), desktop, shown)
    assertEquals(top.slots.scene.rect, { x: rail.x, y: rail.y + PANEL_HEAD, width: rail.width, height: rail.height - PANEL_HEAD })
    // expanded again: as before
    assertEquals(layoutWorkspace(toggleCollapsed(toggleCollapsed(arrangement, "scene"), "scene"), desktop, shown).slots, before.slots)
})

Deno.test("focus hides both rails: the main view takes the width, the rail panels stay mounted but hidden", () => {
    const layout = layoutWorkspace(opened(), desktop, { hide: ["left", "right"] })
    assertEquals(layout.stage, layout.area)
    assert(layout.slots.map.hidden && layout.slots.settings.hidden)
    assert(!layout.slots["camera:1"].hidden)
})

Deno.test("snapping a dragged header: near or over a rail it docks there (at the pointer's height), on the main view's middle it swaps, else it floats", () => {
    const arrangement = opened()
    const layout = layoutWorkspace(arrangement, desktop, shown)
    const box = { x: 600, y: 300, width: 320, height: 240 }
    // over the right rail, below settings: second in the rail
    const settings = layout.slots.settings.rect
    const right = dropTarget(arrangement, desktop, shown, "map", { x: settings.x + 40, y: settings.y + settings.height + 4 }, box)
    assertEquals([right.zone, "index" in right && right.index], ["right", 1])
    assert(within(right.preview, layout.rails.right!))
    // at the window's left edge, above everything: first in the left rail
    const left = dropTarget(arrangement, desktop, shown, "tf", { x: 4, y: layout.area.y + 2 }, box)
    assertEquals([left.zone, "index" in left && left.index], ["left", 0])
    // the main view's middle: swap
    const middle = dropTarget(arrangement, desktop, shown, "scene", center(layout.stage), box)
    assertEquals(middle.zone, "stage")
    assertEquals(middle.preview, layout.stage)
    // the main view's corner area: float, the box's left edge pulled onto the stage's (within the snap distance)
    const near = { ...box, x: layout.stage.x + SNAP_PX - 3, y: layout.stage.y + 200 }
    const floating = dropTarget(arrangement, desktop, shown, "scene", { x: near.x + 40, y: near.y + 10 }, near)
    assertEquals(floating.zone, "float")
    assertEquals(floating.preview.x, layout.stage.x)
    // too far from any edge: where it was dropped
    const free = { ...box, x: layout.stage.x + 60, y: layout.stage.y + 200 }
    const loose = dropTarget(arrangement, desktop, shown, "scene", { x: free.x + 40, y: free.y + 10 }, free)
    assertEquals([loose.preview.x, loose.preview.y], [free.x, free.y])
})

Deno.test("a hidden (empty) rail still takes a header dropped at its edge", () => {
    const arrangement = { ...opened(), left: [], right: [...opened().right, "map", "scene"] }
    const layout = layoutWorkspace(arrangement, desktop, shown)
    assertEquals(layout.rails.left, undefined)
    const target = dropTarget(arrangement, desktop, shown, "map", { x: 10, y: 400 }, { x: 0, y: 380, width: 320, height: 240 })
    assertEquals(target.zone, "left")
    const after = layoutWorkspace(movePanel(arrangement, "map", target), desktop, shown)
    assert(after.rails.left && within(after.slots.map.rect, after.rails.left))
})

Deno.test("snapBox: each axis snaps to the nearest guide edge within the threshold", () => {
    const guide = { x: 100, y: 100, width: 400, height: 300 }
    assertEquals(snapBox({ x: 108, y: 50, width: 100, height: 40 }, [guide], 10), { x: 100, y: 60, width: 100, height: 40 })
    // its right edge onto the guide's right edge
    assertEquals(snapBox({ x: 395, y: 200, width: 100, height: 40 }, [guide], 10).x, 400)
    // out of range: unchanged
    assertEquals(snapBox({ x: 130, y: 200, width: 100, height: 40 }, [guide], 10), { x: 130, y: 200, width: 100, height: 40 })
})

Deno.test("main view: a panel moved onto it swaps with the one there (which takes its old place)", () => {
    const arrangement = opened()
    const swapped = movePanel(arrangement, "scene", { zone: "stage" })
    assertEquals(swapped.stage, "scene")
    assertEquals(swapped.left, ["map", "camera:1"])
    // from floating: the old main view floats where it was
    const floated = movePanel(arrangement, "map", { zone: "float", box: { x: 500, y: 200, width: 300, height: 300 } })
    const back = movePanel(floated, "map", { zone: "stage" })
    assertEquals(back.floating, [{ id: "camera:1", x: 500, y: 200, width: 300, height: 300 }])
    // from a rail on the other side: the old one takes its slot there
    const tf = movePanel(arrangement, "tf", { zone: "stage" })
    assertEquals([tf.stage, tf.right.at(-1)], ["tf", "camera:1"])
})

Deno.test("the panel actions: collapse, pop out and dock back, show", () => {
    const arrangement = opened()
    const layout = layoutWorkspace(arrangement, desktop, shown)
    // fold / unfold; the main view never folds
    assert(toggleCollapsed(arrangement, "map").collapsed.includes("map"))
    assertEquals(toggleCollapsed(arrangement, "camera:1"), arrangement)
    // pop out: floats over the main view at its own size; again: docks into the rail on its side
    const out = popOut(arrangement, "settings", layout)
    const box = out.floating.find((other) => other.id === "settings")!
    assert(within(box, layout.stage))
    assertEquals(locate(out, "settings")?.zone, "float")
    const docked = popOut(out, "settings", layout)
    assertEquals(locate(docked, "settings")?.zone, "right")
    // it remembers where it floated
    assertEquals(popOut(docked, "settings", layout).floating.find((other) => other.id === "settings"), box)
    // show: expanded where it is
    const shownLayers = showPanel(arrangement, "tf")
    assertEquals(locate(shownLayers, "tf")?.zone, "right")
    assert(!shownLayers.collapsed.includes("tf"))
})

Deno.test("splitters: the pair's share moves, their total height doesn't; rails stay within their limits", () => {
    const arrangement = opened()
    const layout = layoutWorkspace(arrangement, desktop, shown)
    const before = layout.slots.map.rect.height + layout.slots.scene.rect.height
    const after = layoutWorkspace(resizeSplit(arrangement, "map", "scene", 80, layout), desktop, shown)
    assertEquals(after.slots.map.rect.height + after.slots.scene.rect.height, before)
    assert(Math.abs(after.slots.map.rect.height - (layout.slots.map.rect.height + 80)) <= 1)
    // never squeezed past a minimum
    const squeezed = layoutWorkspace(resizeSplit(arrangement, "map", "scene", 5000, layout), desktop, shown)
    assert(squeezed.slots.scene.rect.height >= PANEL_HEAD + 60)
    assertEquals(resizeRail(arrangement, "left", 5).leftWidth, 220)
    assertEquals(resizeRail(arrangement, "right", 9999).rightWidth, 640)
})

Deno.test("phone: one panel at a time, filling the screen: the main view's, else the first camera", () => {
    const arrangement = opened()
    const layout = layoutWorkspace(arrangement, phone, shown)
    assertEquals(layout.slots["camera:1"].rect, { x: 0, y: 48, width: 390, height: 472 })
    assert(["map", "scene", "settings", "tf"].every((id) => layout.slots[id].hidden))
    // nothing in the main view: the first camera shows anyway
    const noStage = { ...arrangement, stage: null, left: ["map", "camera:1", "scene"] }
    assertEquals(phonePanel(noStage), "camera:1")
    assert(!layoutWorkspace(noStage, phone, shown).slots["camera:1"].hidden)
    // a floating panel is just another one the phone isn't showing
    const floated = movePanel(arrangement, "tf", { zone: "float", box: { x: 900, y: 200, width: 500, height: 300 } })
    assert(layoutWorkspace(floated, phone, shown).slots.tf.hidden)
    const map = movePanel(arrangement, "map", { zone: "stage" })
    const mapLayout = layoutWorkspace(map, phone, shown)
    assert(!mapLayout.slots.map.hidden && mapLayout.slots["camera:1"].hidden)
})

Deno.test("drop zones: the empty main view whole, else each panel on screen split in half", () => {
    const empty = defaultArrangement(FIXED_PANELS)
    const bare = splitZones(empty, layoutWorkspace(empty, desktop, shown))
    assertEquals(bare.map((zone) => zone.key), ["stage"])
    // the camera alone: its left and right halves make the sides
    const camera = defaultArrangement(IDS)
    const cameraLayout = layoutWorkspace(camera, desktop, shown)
    const halves = splitZones(camera, cameraLayout)
    assertEquals(halves.map((zone) => zone.key), ["stage:left", "stage:right"])
    assertEquals(halves[0].placement, { zone: "left", index: 0 })
    assert(within(halves[0].rect, cameraLayout.stage) && halves[0].rect.width * 2 <= cameraLayout.stage.width + 1)
    // rails full: each unfolded rail panel above and below, the main view (sides taken) and folded TF nothing
    const open = opened()
    const zones = splitZones(open, layoutWorkspace(open, desktop, shown))
    assertEquals(zones.map((zone) => zone.key), ["map:above", "map:below", "scene:above", "scene:below", "settings:above", "settings:below"])
    assertEquals(zones.find((zone) => zone.key === "scene:below")!.placement, { zone: "left", index: 2 })
    // no zone is ever floating
    assert(zones.every((zone) => zone.placement.zone !== "float"))
})

Deno.test("the arrangement survives a reload (this viewer's localStorage), a broken entry falls back to the default", () => {
    const before = localStorage.getItem(WORKSPACE_KEY)
    try {
        const moved = movePanel(opened(), "settings", { zone: "float", box: { x: 400, y: 200, width: 360, height: 420 } })
        saveArrangement(moved)
        assertEquals(loadArrangement(IDS), moved)
        // the shared store saves every change
        workspace.set({ arrangement: toggleCollapsed(moved, "map") })
        assert(loadArrangement(IDS).collapsed.includes("map"))
        localStorage.setItem(WORKSPACE_KEY, "{not json")
        assertEquals(loadArrangement(IDS), defaultArrangement(IDS))
        assertNotEquals(loadArrangement(IDS), moved)
    } finally {
        before === null ? localStorage.removeItem(WORKSPACE_KEY) : localStorage.setItem(WORKSPACE_KEY, before)
    }
})

Deno.test("a layout serializes: JSON out and back in (the agent's GET / PUT api/layout) is the same arrangement", () => {
    let arrangement = placePanel(defaultArrangement([...IDS, "plot:1"]), "scene", { zone: "right", index: 0 }, 1440)
    arrangement = placePanel(arrangement, "plot:1", { zone: "float", box: { x: 300, y: 200, width: 420, height: 260 } }, 1440)
    arrangement = toggleCollapsed(placePanel(arrangement, "map", { zone: "left", index: 0 }, 1440), "map")
    const ids = [...IDS, "plot:1"]
    const restored = normalizeArrangement(JSON.parse(JSON.stringify(arrangement)), ids)
    assertEquals(restored, normalizeArrangement(arrangement, ids))
    assertEquals(layoutWorkspace(restored, desktop, shown).slots, layoutWorkspace(normalizeArrangement(arrangement, ids), desktop, shown).slots)
})
