// What the 2D map panel remembers per viewer (localStorage: a phone and a desktop each keep their own), checked on load.
// Where the panel is and whether it's folded is the workspace's (ui/workspace.ts).
import { DEFAULT_FOLLOW_FRAME, isValidView, type MapView } from "../core/map2d.ts"
import { readLocal } from "../core/videoQuality.ts"

export interface MapLayout {
    /** the base map: "" = the best on the bus (the global map) */
    topic: string
    /** a costmap drawn over the base: "" = none (the default) */
    overlay: string
    /** the TF frame the view follows (following itself is never remembered: a reload always follows) */
    followFrame: string
    view: MapView | null
}

export const LAYOUT_KEY = "lv.map2d"

/** The remembered choices, every field checked: a broken or stale entry falls back to the defaults. */
export function loadMapLayout(saved: Partial<MapLayout> = readLocal<Partial<MapLayout>>(LAYOUT_KEY, {})): MapLayout {
    const text = (value: unknown) => typeof value === "string" ? value : ""
    return {
        topic: text(saved?.topic),
        overlay: text(saved?.overlay),
        followFrame: text(saved?.followFrame) || DEFAULT_FOLLOW_FRAME,
        view: isValidView(saved?.view) ? saved.view : null,
    }
}
