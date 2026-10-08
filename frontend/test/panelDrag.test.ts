// Dragging a panel header (ui/panelDrag.ts): it follows the pointer at its floating size, the preview tracks the
// landing spot, release applies it, Escape and a plain click change nothing, and its own inline box comes back.
import { assertEquals } from "jsr:@std/assert@1"
import { startHeaderDrag } from "../src/ui/panelDrag.ts"
import type { DropTarget } from "../src/ui/workspace.ts"

function fakePanel() {
    const classes = new Set<string>()
    const style = { cssText: "left: 10px; top: 60px; width: 300px; height: 200px;" } as Record<string, string>
    return { element: { style, classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } } as unknown as HTMLElement, style, classes }
}
const pointer = (type: string, x = 0, y = 0) => Object.assign(new Event(type), { clientX: x, clientY: y })

Deno.test("a header drag: follows the pointer, previews, drops where the preview was, restores its inline box", () => {
    const { element, style, classes } = fakePanel()
    const previews: (DropTarget | null)[] = []
    const dropped: DropTarget[] = []
    startHeaderDrag({ clientX: 20, clientY: 70 }, element, {
        size: { width: 400, height: 260 },
        grab: { x: 10, y: 10 },
        target: (at, box) => ({ zone: "float", box, preview: { ...box, x: at.x } }),
        preview: (target) => previews.push(target),
        drop: (target) => dropped.push(target),
    })
    globalThis.dispatchEvent(pointer("pointermove", 220, 300))
    assertEquals([style.left, style.top, style.width, style.height], ["210px", "290px", "400px", "260px"])
    assertEquals(classes.has("dragging"), true)
    assertEquals(previews.at(-1)?.zone, "float")
    globalThis.dispatchEvent(pointer("pointerup", 220, 300))
    assertEquals(dropped.length, 1)
    assertEquals(dropped[0].preview.x, 220)
    assertEquals(previews.at(-1), null)
    assertEquals(style.cssText, "left: 10px; top: 60px; width: 300px; height: 200px;")
    assertEquals(classes.has("dragging"), false)
})

Deno.test("a click (no move) and an Escape mid-drag change nothing", () => {
    const { element } = fakePanel()
    const dropped: unknown[] = []
    const plan = { size: { width: 300, height: 200 }, grab: { x: 5, y: 5 }, target: (_: unknown, box: { x: number; y: number; width: number; height: number }) => ({ zone: "float" as const, box, preview: box }), preview: () => {}, drop: (target: unknown) => dropped.push(target) }
    startHeaderDrag({ clientX: 20, clientY: 70 }, element, plan)
    globalThis.dispatchEvent(pointer("pointermove", 22, 71))
    globalThis.dispatchEvent(pointer("pointerup", 22, 71))
    assertEquals(dropped, [])
    startHeaderDrag({ clientX: 20, clientY: 70 }, element, plan)
    globalThis.dispatchEvent(pointer("pointermove", 300, 300))
    globalThis.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }))
    globalThis.dispatchEvent(pointer("pointerup", 300, 300))
    assertEquals(dropped, [])
})
