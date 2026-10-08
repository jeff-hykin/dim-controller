// The palette's commands (ui/commands.ts): the multi-word filter, and every panel's four actions, the same ones in the
// same order wherever it is, offered in the palette when they apply.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { type Command, filterCommands, panelActionStates, panelCommands, panelTitle } from "../src/ui/commands.ts"
import { defaultArrangement, FIXED_PANELS, movePanel } from "../src/ui/workspace.ts"

const IDS = ["camera:1", ...FIXED_PANELS]
const command = (id: string, label: string, extra: Partial<Command> = {}): Command => ({ id, label, group: "View", run: () => {}, ...extra })

Deno.test("filter: every word must match (label, group, hint, keys, extra words), order kept; empty is everything", () => {
    const all = [command("a", "STOP: stop driving now", { group: "Drive", keys: ["Space"], words: "estop" }), command("b", "Map: show", { group: "Panels" }), command("c", "Reset the layout", { group: "Layout" })]
    assertEquals(filterCommands(all, "").map((c) => c.id), ["a", "b", "c"])
    assertEquals(filterCommands(all, "estop").map((c) => c.id), ["a"])
    assertEquals(filterCommands(all, "space").map((c) => c.id), ["a"])
    assertEquals(filterCommands(all, "map SHOW").map((c) => c.id), ["b"])
    assertEquals(filterCommands(all, "map reset").map((c) => c.id), [])
    assertEquals(filterCommands(all, "  layout  ").map((c) => c.id), ["c"])
})

Deno.test("every panel has the same four actions in the same order, wherever it is", () => {
    const arrangement = movePanel(defaultArrangement(IDS), "tf", { zone: "float", box: { x: 400, y: 200, width: 300, height: 300 } })
    for (const id of IDS) {
        assertEquals(panelActionStates(arrangement, id, { mobile: false, focused: false }).map((state) => state.action), ["collapse", "main", "popout", "close"], id)
    }
})

Deno.test("what each action does depends on where the panel is", () => {
    const arrangement = movePanel(defaultArrangement(IDS), "tf", { zone: "float", box: { x: 400, y: 200, width: 300, height: 300 } })
    const states = (id: string, options = { mobile: false, focused: false }) => Object.fromEntries(panelActionStates(arrangement, id, options).map((state) => [state.action, state]))
    // the main view can't fold; its main button is focus
    assert(states("camera:1").collapse.disabled)
    assert(/Focus/.test(states("camera:1").main.label))
    assert(/rails again/.test(states("camera:1", { mobile: false, focused: true }).main.label))
    // a rail panel: fold, swap into the main view, float
    assert(!states("map").collapse.disabled && /swap/.test(states("map").main.label) && /float/i.test(states("map").popout.label))
    // a floating one docks back
    assert(/Dock/.test(states("tf").popout.label))
    // a phone can't float
    assert(states("map", { mobile: true, focused: false }).popout.disabled)
})

Deno.test("the palette has a show command and each applicable action for every panel", () => {
    const arrangement = defaultArrangement(IDS)
    const acted: string[] = []
    for (const id of IDS) {
        const commands = panelCommands(arrangement, id, panelTitle(id), { mobile: false, focused: false }, (action) => acted.push(`${id}.${action}`))
        assert(commands[0].label.endsWith(": show"))
        for (const one of commands) {
            one.run()
        }
    }
    // a rail panel: show, fold, main, pop out, close
    assertEquals(acted.filter((entry) => entry.startsWith("map.")), ["map.show", "map.collapse", "map.main", "map.popout", "map.close"])
    // the main view: no fold
    assertEquals(acted.filter((entry) => entry.startsWith("camera:1.")), ["camera:1.show", "camera:1.main", "camera:1.popout", "camera:1.close"])
    assertEquals(panelTitle("camera:2"), "Camera 2")
    assertEquals(panelTitle("scene"), "3D view")
})
