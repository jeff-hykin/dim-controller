import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { groundLevel, nearestCluster } from "../src/core/locate.ts"

Deno.test("the nearest dense depth band wins over a wall behind it", () => {
    const person = Array.from({ length: 40 }, (_, index) => ({ depth: 2.4 + (index % 4) * 0.08, id: "person" }))
    const wall = Array.from({ length: 200 }, (_, index) => ({ depth: 4.0 + (index % 3) * 0.02, id: "wall" }))
    const speck = [{ depth: 1.0, id: "speck" }]
    const cluster = nearestCluster([...wall, ...speck, ...person])
    assertEquals(cluster.length, 40)
    assertEquals(new Set(cluster.map((hit) => hit.id)), new Set(["person"]))
    assertEquals(nearestCluster([]), [])
})

Deno.test("the floor is a low percentile of the nearby points", () => {
    const floor = Array.from({ length: 100 }, (_, index) => new Vector3(index * 0.03, 0, 0.01))
    const person = Array.from({ length: 50 }, (_, index) => new Vector3(2, 0, index * 0.035))
    const far = [new Vector3(50, 0, -3)]
    assertAlmostEquals(groundLevel([...floor, ...person, ...far], new Vector3()), 0.01)
    assertEquals(groundLevel([], new Vector3()), 0)
})
