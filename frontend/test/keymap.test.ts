// The keyboard (ui/keymap.ts): Space stops always (even while typing, where it still types), drive keys and Shift only
// when nothing is typed and no overlay is open, `/` and `?` open the palette and the shortcut list, Escape closes,
// browser/shell shortcuts pass through; and the `?` list names every binding.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { isTypingTarget, keyBindings, type KeyContext, routeKeyDown } from "../src/ui/keymap.ts"
import { groundKeys } from "../src/profile/keys.ts"
import dog from "../src/profile/dog.ts"

const free: KeyContext = { typing: false, overlay: null, driveKeys: groundKeys }
const typing: KeyContext = { ...free, typing: true }
const palette: KeyContext = { ...free, overlay: "palette" }
const key = (code: string, key = code, extra: Record<string, boolean> = {}) => ({ code, key, ...extra })

Deno.test("WASD, Q/E and the arrows drive (hold); Shift boosts", () => {
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        assertEquals(routeKeyDown(key(code), free), { kind: "drive" }, code)
    }
    assertEquals(routeKeyDown(key("ShiftLeft", "Shift"), free), { kind: "boost", on: true })
    assertEquals(routeKeyDown(key("KeyZ", "z"), free), { kind: "none" })
})

Deno.test("Space stops always: consumed normally, typed (not consumed) in a field, and with the palette open", () => {
    assertEquals(routeKeyDown(key("Space", " "), free), { kind: "stop", consume: true })
    assertEquals(routeKeyDown(key("Space", " "), typing), { kind: "stop", consume: false })
    assertEquals(routeKeyDown(key("Space", " "), palette), { kind: "stop", consume: true })
    // Cmd+Space is the system's, not a stop
    assertEquals(routeKeyDown(key("Space", " ", { metaKey: true }), free), { kind: "none" })
})

Deno.test("keys are ignored while typing and while an overlay is open (no drive, no palette)", () => {
    assertEquals(routeKeyDown(key("KeyW", "w"), typing), { kind: "none" })
    assertEquals(routeKeyDown(key("Slash", "/"), typing), { kind: "none" })
    assertEquals(routeKeyDown(key("Slash", "?", { shiftKey: true }), typing), { kind: "none" })
    assertEquals(routeKeyDown(key("KeyW", "w"), palette), { kind: "none" })
    assertEquals(routeKeyDown(key("ShiftLeft", "Shift"), { ...free, overlay: "help" }), { kind: "none" })
})

Deno.test("/ opens the palette, ? the shortcut list, Escape closes (even while typing), [ ] \\ the rails", () => {
    assertEquals(routeKeyDown(key("Slash", "/"), free), { kind: "palette" })
    assertEquals(routeKeyDown(key("Slash", "?", { shiftKey: true }), free), { kind: "help" })
    assertEquals(routeKeyDown(key("Escape", "Escape"), typing), { kind: "close" })
    assertEquals(routeKeyDown(key("Escape", "Escape"), palette), { kind: "close" })
    assertEquals(routeKeyDown(key("BracketLeft", "["), free), { kind: "rail", side: "left" })
    assertEquals(routeKeyDown(key("BracketRight", "]"), free), { kind: "rail", side: "right" })
    assertEquals(routeKeyDown(key("Backslash", "\\"), free), { kind: "focus" })
})

Deno.test("Ctrl/Alt/Meta combinations belong to the browser and Desktop's shell", () => {
    assertEquals(routeKeyDown(key("KeyW", "w", { metaKey: true }), free), { kind: "none" })
    assertEquals(routeKeyDown(key("KeyS", "s", { ctrlKey: true }), free), { kind: "none" })
    assertEquals(routeKeyDown(key("Slash", "/", { altKey: true }), free), { kind: "none" })
})

Deno.test("a field, select or contenteditable is typing; the page isn't", () => {
    assert(isTypingTarget({ tagName: "INPUT" }))
    assert(isTypingTarget({ tagName: "TEXTAREA" }))
    assert(isTypingTarget({ tagName: "SELECT" }))
    assert(isTypingTarget({ tagName: "DIV", isContentEditable: true }))
    assert(!isTypingTarget({ tagName: "BODY" }))
    assert(!isTypingTarget(null))
})

Deno.test("the ? list names every binding: drive keys grouped per action, then Space, /, ?, Esc and the rails", () => {
    const bindings = keyBindings(dog)
    const find = (action: string) => bindings.find((binding) => binding.action.startsWith(action))
    assertEquals(find("Forward")?.keys, ["W", "↑"])
    assertEquals(find("Turn left")?.keys, ["A", "←"])
    assertEquals(find("Strafe right")?.keys, ["E"])
    assertEquals(find("STOP")?.keys, ["Space"])
    assertEquals(find("Boost")?.keys, ["Shift"])
    for (const keys of [["/"], ["?"], ["Esc"], ["["], ["]"], ["\\"]]) {
        assert(bindings.some((binding) => binding.keys.join() === keys.join()), keys.join())
    }
    // every drive key in the profile is listed
    const listed = bindings.flatMap((binding) => binding.keys)
    assertEquals(Object.keys(dog.drive.keys).length, 10)
    assert(["W", "A", "S", "D", "Q", "E", "↑", "↓", "←", "→"].every((name) => listed.includes(name)))
})
