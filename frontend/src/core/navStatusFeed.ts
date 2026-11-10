// Every actionlib_msgs.GoalStatus topic on the bridge: what the global planner says about the goal it was given
// (dimos's MLS planner publishes dimos/nav_status), for the bar's nav chip (ui/BarChips.tsx). Without it a goal that
// cannot be planned looks exactly like a goal being driven to -- the robot simply stops, and the page says nothing.
// Streamed at low priority, latest-only: only the newest status matters.
import { decode, type LcmValue } from "./lcm/lcm.ts"
import { type Connection, Priority } from "./transport.ts"
import { PRIORITY_TIERS } from "./bandwidth.ts"
import { Store } from "./store.ts"

/** actionlib_msgs/GoalStatus */
export const PENDING = 0
export const ACTIVE = 1
export const PREEMPTED = 2
export const SUCCEEDED = 3
export const ABORTED = 4
export const REJECTED = 5
export const PREEMPTING = 6
export const RECALLING = 7
export const RECALLED = 8
export const LOST = 9

/** a status older than this is stale: the chip goes */
export const NAV_STALE_MS = 15_000
/** how long a finished goal (reached, cancelled) stays on the bar before the chip goes */
export const NAV_DONE_MS = 6000

/** the GoalStatus subscription's options: low priority, latest-only (only the newest status is worth anything) */
export const NAV_SUBSCRIBE = { maxHz: 4, delivery: "latest", priority: Priority.BACKGROUND, bandwidthPriority: PRIORITY_TIERS.background } as const

export interface NavStatus {
    topic: string
    status: number
    /** the planner's own reason, when it gave one */
    text: string
    receivedAt: number
}

export const navStatus = new Store<{ latest: NavStatus | null }>({ latest: null })

/** A GoalStatus as the chip reads it. A message with no status at all is taken as lost, never as active. */
export function navStatusOf(topic: string, message: LcmValue, receivedAt: number): NavStatus {
    return { topic, status: Number(message?.status ?? LOST), text: String(message?.text ?? ""), receivedAt }
}

export function feedNavStatus(connection: Connection) {
    const subscribed = new Set<string>()
    const sync = () => {
        for (const topic of connection.status.get().topics) {
            if (topic.type !== "actionlib_msgs.GoalStatus" || subscribed.has(topic.key)) {
                continue
            }
            subscribed.add(topic.key)
            connection.subscribe(topic.key, { ...NAV_SUBSCRIBE }, (message) => {
                try {
                    const decoded = decode("actionlib_msgs.GoalStatus", message.bytes)
                    navStatus.set({ latest: navStatusOf(topic.name, decoded, Date.now()) })
                } catch {
                    // a malformed message: skip it
                }
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}
