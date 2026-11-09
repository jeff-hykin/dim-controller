// Keeps the TF tree fed: every tf2_msgs.TFMessage topic named tf or tf_static (namespaced too: /robot/tf) on the bridge,
// always (the tf layer only draws it); one named like tf_static is treated as static (exempt from staleness). Other
// TFMessage topics are side channels, not the tree: a planner's own tip frames (manipulation_tf) would give links a
// second parent.
import { decode } from "./lcm/lcm.ts"
import type { Connection } from "./transport.ts"
import type { TfTree } from "dimos-react/three"
import type { Viewer } from "dimos-react/three"
import type { TfHistory } from "./tfHistory.ts"
import { captureClock } from "./captureClock.ts"

/**
 * Whether tf arrives with usable capture stamps, read out of `__dim.tfStampReport()`.
 *
 * Measured on this sim: 197530 transforms, 197530 of them stamped, none missing, and a median gap
 * to arrival of 115580.9 ms against the clouds' offset of 115612.9 ms -- the same pair of clocks,
 * to within 32 ms. That is what makes feeding the clock from tf sound.
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
    const clock = captureClock(connection)
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
                let observed = false
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
                        // The clouds' clock offset, learned from tf instead of from the clouds.
                        //
                        // Both cross the same pair of clocks, but a transform is a few dozen bytes at
                        // 50 Hz where a scan is hundreds of kilobytes at 10 -- so tf's quickest sample
                        // sat 32 ms BELOW the best a cloud ever managed. The offset is read off the
                        // quickest sample there is, and the correction is only as good as that floor,
                        // so the floor should come from the traffic that is cheapest to send.
                        //
                        // Once per message, not once per transform. One message carries a whole
                        // tree's worth of them stamped alike, and this sim pushes ~660 a second: at
                        // that rate the clock's window holds thousands of samples and re-fitting it
                        // on every one is millions of operations a second, on the thread that draws.
                        if (!observed) {
                            observed = true
                            clock.observe(message.timestamp, stampMs)
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
