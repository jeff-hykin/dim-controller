// The instant the view is showing.
//
// A scan is drawn where it was taken; a robot model was drawn wherever tf had got to by the time
// the frame went out. Both are right on their own and they are not the same moment, so during a
// turn the robot's own returns sit off to one side of the model it came from -- a ghost that
// swaps sides when the turn reverses. Measured on this sim: six to fifteen degrees apart at
// 0.8 rad/s, about 220 ms of pipeline.
//
// So the view keeps one instant, and whatever is posed from tf is posed at it. It is the newest
// sensor frame actually drawn, not `now`: the data cannot be made earlier, so everything else is
// shown as it was when the data was taken. Nothing sets it until a layer draws something stamped,
// and until then every reader carries on asking tf for the latest, which is what they all did.

/** The newest drawn sensor frame's own time, in the clock tf is kept in; null until one is drawn. */
let stamp: number | null = null
/** Bumped whenever the instant moves, so a reader can tell "unchanged" from "nothing yet". */
let version = 0

/** Called by a layer that has just drawn data at a known time. */
export function showing(at: number): void {
    if (at !== stamp) {
        stamp = at
        version++
    }
}

/** The instant to pose by, or null to use whatever tf has latest. */
export function shownAt(): number | null {
    return stamp
}

/** Changes when the instant does. */
export function shownVersion(): number {
    return version
}

/** Forgotten when the data stops, so a stale instant cannot pin the view to the past. */
export function forgetShown(): void {
    stamp = null
    version++
}
