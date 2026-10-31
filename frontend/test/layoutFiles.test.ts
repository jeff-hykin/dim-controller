// Layout files (core/layoutFiles.ts): only the parts PUT api/layout takes are kept, and only *.layout.json files count.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { isLayoutFile, layoutParts } from "../src/core/layoutFiles.ts"

Deno.test("a layout keeps desktop, phone, cameras and plots, and drops null parts and anything else", () => {
    const desktop = { stage: "scene", left: [], right: [] }
    assertEquals(layoutParts({ desktop, phone: null, cameras: [{ id: 1, key: "dimos/a/sensor_msgs.Image" }], fixedPanels: ["map"], extra: 1 }), { desktop, cameras: [{ id: 1, key: "dimos/a/sensor_msgs.Image" }] })
    assertEquals(layoutParts([1, 2]), {})
    assertEquals(layoutParts("desktop"), {})
    assertEquals(layoutParts(null), {})
})

Deno.test("only .layout.json files are layouts", () => {
    assert(isLayoutFile(new File(["{}"], "lab.layout.json")))
    assert(isLayoutFile(new File(["{}"], "LAB.LAYOUT.JSON")))
    assert(!isLayoutFile(new File(["{}"], "lab.json")))
})
