// The gamepad remapping (core/padMapping.ts): the default leaves the pad alone; swapped sticks, inverted turning and
// moved buttons land where the driver reads them, and a moved button no longer does its standard job.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { DEFAULT_MAPPING, normalizeMapping, remapPad } from "../src/core/padMapping.ts"

const pad = (axes: number[], pressed: number[] = []) => ({
    index: 0,
    id: "pad",
    mapping: "standard",
    connected: true,
    axes,
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })),
})

Deno.test("the default mapping is the pad itself", () => {
    const raw = pad([0.1, 0.2, 0.3, 0.4])
    assertEquals(remapPad(raw, DEFAULT_MAPPING), raw)
})

Deno.test("right stick drives, turning inverted", () => {
    const mapped = remapPad(pad([0.1, 0.2, 0.3, 0.4]), { ...DEFAULT_MAPPING, driveStick: "right", invertTurn: true })
    assertEquals(mapped.axes.slice(0, 4), [0.3, 0.4, -0.1, 0.2])
})

Deno.test("buttons move to the driver's places; a moved one stops doing its own job", () => {
    // boost on A (0), stop on LB + RB (4, 5), confirm on X (2)
    const mapping = { ...DEFAULT_MAPPING, boost: 0, stop: [4, 5] as [number, number], confirm: 2 }
    const boosting = remapPad(pad([0, 0, 0, 0], [0]), mapping)
    assert(boosting.buttons[5].pressed, "A boosts (the driver reads RB)")
    assert(!boosting.buttons[0].pressed, "A no longer confirms")
    const stopping = remapPad(pad([0, 0, 0, 0], [4, 5]), mapping)
    assert(stopping.buttons[6].pressed && stopping.buttons[7].pressed, "LB + RB read as LT + RT")
    const confirming = remapPad(pad([0, 0, 0, 0], [2]), mapping)
    assert(confirming.buttons[0].pressed)
    // the old triggers do nothing now
    const triggers = remapPad(pad([0, 0, 0, 0], [6, 7]), mapping)
    assert(!triggers.buttons[6].pressed && !triggers.buttons[7].pressed)
})

Deno.test("normalizeMapping: junk is the default", () => {
    assertEquals(normalizeMapping(null), DEFAULT_MAPPING)
    assertEquals(normalizeMapping({ driveStick: "up" as never, boost: -1, stop: [99, "x"] as never }), DEFAULT_MAPPING)
})
