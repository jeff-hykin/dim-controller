// Telling "this surface is drawn twice" from "these two parts sit inside each other".
//
// The detector used to key on the bounding sphere alone, and a shelf unit whose frame and shelves
// each span its full extent reported as a duplicate every time. An hour went into chasing one of
// those before hashing the assets' vertices showed the geometry was not the same at all.
import { assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { coincidentMeshes } from "../src/core/debugHook.ts"

/** A box of `segments` detail, so two meshes can share an extent but not a vertex count. */
function part(size: number, segments: number): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size, segments, segments, segments))
    mesh.updateMatrixWorld()
    return mesh
}

Deno.test("two parts spanning the same extent are not a duplicate", () => {
    const scene = new THREE.Scene()
    // a frame and the shelves inside it: same centre, same reach, different geometry
    scene.add(part(2, 1), part(2, 3))
    assertEquals(coincidentMeshes(scene, () => "room"), [])
})

Deno.test("the same surface drawn twice is a duplicate", () => {
    const scene = new THREE.Scene()
    scene.add(part(2, 1), part(2, 1))
    const found = coincidentMeshes(scene, () => "room")
    assertEquals(found.length, 1)
    assertEquals(found[0].count, 2)
    assertEquals(found[0].under, ["room"])
})

Deno.test("the same geometry somewhere else is not a duplicate", () => {
    const scene = new THREE.Scene()
    const moved = part(2, 1)
    moved.position.set(5, 0, 0)
    moved.updateMatrixWorld()
    scene.add(part(2, 1), moved)
    assertEquals(coincidentMeshes(scene, () => "room"), [])
})

Deno.test("a mesh nobody can see does not count", () => {
    const scene = new THREE.Scene()
    const hidden = part(2, 1)
    hidden.visible = false
    scene.add(part(2, 1), hidden)
    assertEquals(coincidentMeshes(scene, () => "room"), [])
})
