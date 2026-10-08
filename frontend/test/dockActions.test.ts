// The action dock follows the main view (ui/dockActions.ts): the dock shows the actions of whichever panel is the main
// view, so a camera's never show the 3D view's (recenter) and the other way round.
import { assertEquals } from "jsr:@std/assert@1"
import { type DockAction, dockActionsFor } from "../src/ui/dockActions.ts"

const action = (id: string): DockAction => ({ id, label: id, icon: "target", title: id, run: () => {} })
const offered = {
    "camera:1": [action("fill"), action("next"), action("quality")],
    scene: [action("follow")],
    map: [action("follow"), action("fit")],
}
const ids = (stage: string | null) => dockActionsFor(offered, stage).map((one) => one.id)

Deno.test("the dock's panel actions are the main view's own", () => {
    assertEquals(ids("camera:1"), ["fill", "next", "quality"])
    assertEquals(ids("scene"), ["follow"])
    assertEquals(ids("map"), ["follow", "fit"])
    // a panel without any, or an empty main view: none
    assertEquals(ids("settings"), [])
    assertEquals(ids(null), [])
})
