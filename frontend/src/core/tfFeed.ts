// Keeps the TF tree fed: every tf2_msgs.TFMessage topic named tf or tf_static (namespaced too: /robot/tf) on the bridge,
// always (the tf layer only draws it); one named like tf_static is treated as static (exempt from staleness). Other
// TFMessage topics are side channels, not the tree: a planner's own tip frames (manipulation_tf) would give links a
// second parent.
import { decode } from "./lcm/lcm.ts"
import type { Connection } from "./transport.ts"
import type { TfTree } from "dimos-react/three"
import type { Viewer } from "dimos-react/three"
import type { TfHistory } from "./tfHistory.ts"

/**
 * Whether tf arrives with usable capture stamps, which decides how a cloud can be placed in time.
 *
 * Right now tf is recorded at arrival and a cloud's capture stamp is converted into that clock by
 * estimating the clocks' difference off the traffic (core/captureClock.ts) -- good to about a
 * frame, but an estimate. Every TransformStamped carries its own stamp, so if they are all there
 * and all on the clouds' clock, both sides could be recorded at capture time and the estimate
 * could go. If some edges have a stamp and others do not, they cannot: the history would hold two
 * clocks tens of seconds apart and place things nowhere near right. So count, and read it out of
 * `__dim.tfStampReport()` before changing anything.
 */
export const tfStampHealth = {
    transforms: 0,
    withStamp: 0,
    /** arrival - stamp, ms: the same gap a cloud shows if they share a clock. */
    gapMs: [] as number[],
    edgesWithout: new Set<string>(),
}

/** A TransformStamped's own capture time in ms, or null where it carries none. */
function stampMsOf(header: { stamp?: { sec?: number; nsec?: number } } | undefined): number | null {
    const stamp = header?.stamp
    if (!stamp || typeof stamp.sec !== "number" || !stamp.sec) {
        return null // ROS publishers that never fill it leave sec at 0
    }
    return stamp.sec * 1000 + (stamp.nsec ?? 0) / 1e6
}

export function feedTf(connection: Connection, tf: TfTree, viewer: Viewer, history: TfHistory) {
    const subscribed = new Set<string>()
    const sync = () => {
        for (const topic of connection.status.get().topics) {
            if (topic.type !== "tf2_msgs.TFMessage" || !isTreeTopic(topic.name) || subscribed.has(topic.key)) {
                continue
            }
            subscribed.add(topic.key)
            const isStatic = /static/i.test(topic.name)
            // reliable: one tf topic often carries different edges from different publishers, so none may be dropped
            connection.subscribe(topic.key, { delivery: "reliable" }, (message) => {
                let decoded
                try {
                    decoded = decode("tf2_msgs.TFMessage", message.bytes)
                } catch {
                    return
                }
                for (const stamped of decoded.transforms ?? []) {
                    const { translation, rotation } = stamped.transform ?? {}
                    if (!translation || !rotation) {
                        continue
                    }
                    const parent = stamped.header?.frame_id ?? "", child = stamped.child_frame_id ?? ""
                    const position: [number, number, number] = [translation.x, translation.y, translation.z]
                    const quaternion: [number, number, number, number] = [rotation.x, rotation.y, rotation.z, rotation.w]
                    tf.set(parent, child, position, quaternion, isStatic)
                    history.record(parent, child, position, quaternion, message.timestamp, isStatic)
                    tfStampHealth.transforms++
                    const stampMs = stampMsOf(stamped.header)
                    if (stampMs === null) {
                        tfStampHealth.edgesWithout.add(`${parent}->${child}`)
                    } else {
                        tfStampHealth.withStamp++
                        tfStampHealth.gapMs.push(message.timestamp - stampMs)
                        if (tfStampHealth.gapMs.length > 200) {
                            tfStampHealth.gapMs.shift()
                        }
                    }
                }
                viewer.noteData(message.timestamp)
            })
        }
    }
    connection.status.subscribe(sync)
    sync()
}

/** A tf tree topic: its last path part is tf or tf_static. */
export function isTreeTopic(name: string): boolean {
    return /^tf(_static)?$/.test(name.split("/").filter(Boolean).pop() ?? "")
}
