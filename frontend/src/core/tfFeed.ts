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
    /**
     * The smallest gap ever seen, which is NOT just the median's quicker tail.
     *
     * Measured here: the median gap is ~115581 ms and the quickest is ~8 ms. Those are two
     * populations, not one spread -- tf carries edges stamped on the sim's clock and edges stamped
     * on wall time, from different publishers. It matters because an offset is read off the
     * QUICKEST sample, so feeding this traffic to the clock reads the wall-stamped edges and puts
     * every cloud two minutes in the past. The median hid that completely.
     */
    quickestGapMs: Number.POSITIVE_INFINITY,
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
                        const gap = message.timestamp - stampMs
                        tfStampHealth.gapMs.push(gap)
                        if (tfStampHealth.gapMs.length > 200) {
                            tfStampHealth.gapMs.shift()
                        }
                        if (gap < tfStampHealth.quickestGapMs) {
                            tfStampHealth.quickestGapMs = gap
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
