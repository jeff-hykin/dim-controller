// Thumb-stick shaping and smoothing (core/stick.ts): dead zone, expo, single-axis sticks, and a release that never eases.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { DEAD_ZONE, shapeStick, smoothToward } from "../src/core/stick.ts"

Deno.test("a resting thumb inside the dead zone sends nothing; the edge is full speed; up is +y", () => {
    assertEquals(shapeStick(0, 0, 60), { x: 0, y: 0 })
    assertEquals(shapeStick(60 * DEAD_ZONE * 0.9, 0, 60), { x: 0, y: 0 })
    assertEquals(shapeStick(0, -60, 60), { x: 0, y: 1 })
    assertEquals(shapeStick(60, 0, 60), { x: 1, y: 0 })
    // past the ring is still 1
    assertEquals(shapeStick(0, 200, 60), { x: 0, y: -1 })
})

Deno.test("expo: half way out is well under half speed, and the direction is kept (radial, no snapping)", () => {
    const half = shapeStick(0, -30, 60)
    assert(half.y > 0 && half.y < 0.5, `half-way gives ${half.y}`)
    const diagonal = shapeStick(60, -60, 60)
    assertAlmostEquals(diagonal.x, diagonal.y, 0.002)
    assertAlmostEquals(Math.hypot(diagonal.x, diagonal.y), 1, 0.002)
})

Deno.test("a one-axis stick ignores the other axis", () => {
    assertEquals(shapeStick(60, -60, 60, "x"), { x: 1, y: 0 })
    assertEquals(shapeStick(60, -60, 60, "y"), { x: 0, y: 1 })
    assertEquals(shapeStick(3, -60, 60, "x"), { x: 0, y: 0 })
})

Deno.test("smoothing eases toward the thumb, reaches it, and a release is zero at once", () => {
    const first = smoothToward(0, 1, 16)
    assert(first > 0 && first < 0.5, `one frame in: ${first}`)
    let value = 0
    for (let frame = 0; frame < 60; frame++) {
        value = smoothToward(value, 1, 16)
    }
    assertEquals(value, 1)
    assertEquals(smoothToward(0.9, 0, 1), 0)
    assertEquals(smoothToward(-0.4, 0, 0), 0)
})
