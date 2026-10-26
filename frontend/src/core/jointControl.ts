// Joint control in the 3D view: off until its "Enable joint control" button is pressed (the arm gizmos, Plan /
// Execute and the joint tabs show only then); the side area's tab. A backend setting, so every open page and the agent
// see whether it's on.
import { persistentStore } from "./store.ts"

export const jointControlState = persistentStore<{ enabled: boolean; tab: "joints" | "settings" }>("lv.jointControl", { enabled: false, tab: "joints" })
