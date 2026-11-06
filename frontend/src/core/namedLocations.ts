// dimos's named locations (dimos/mapping/relocalization/module.py): named poses the module keeps in its map frame
// ("map", or "premap" on the M20, whose LIO frame is already map). /named_locations is the whole list, one
// InteractiveMarkerUpdate whose server_id/seq_num name the module run and the list's revision. The page replaces its
// cache with each list it hears (one older than the cached revision of the same run excepted: the echo of a superseded
// edit), and sends /named_locations_request on every connect. An add, move, rename or delete is a new whole list
// carrying the server_id/seq_num of the list it was edited from: the module adopts it only if that's its current
// revision, else drops it and republishes. Go to is the location's pose as a PointStamped on the planner's /goal.
// `state.locations` is null until a list comes: then the module is there, and the 3D view's labels are these (core/labels.ts).
import { decode, encode } from "./lcm/lcm.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey } from "./transport.ts"
import type { LocationLabel } from "./labels.ts"

export const UPDATE_TYPE = "visualization_msgs.InteractiveMarkerUpdate"
export const STRING_TYPE = "std_msgs.String"
export const SNAPSHOT_KEY = dimosKey("/named_locations", UPDATE_TYPE)
export const REQUEST_KEY = dimosKey("/named_locations_request", STRING_TYPE)
export const POINT_STAMPED = "geometry_msgs.PointStamped"
export const GOAL_KEY = dimosKey("/goal", POINT_STAMPED)

/** The module run and revision a list is (or was edited from). */
export type Revision = { server_id: string; seq_num: number }

/** A location in a list: its name and pose (in map, when published). */
export type NamedPose = Pick<LocationLabel, "label" | "frame_id" | "position" | "orientation">

const stampOf = (nowMs: number) => ({ sec: Math.floor(nowMs / 1000), nsec: (nowMs % 1000) * 1_000_000 })

/** A list's revision and its locations, as labels whose id is the name. */
export function readList(bytes: Uint8Array): { revision: Revision; locations: LocationLabel[] } {
    const update = decode(UPDATE_TYPE, bytes)
    return { revision: { server_id: update.server_id, seq_num: Number(update.seq_num) }, locations: snapshotLabels(update) }
}

// deno-lint-ignore no-explicit-any
function snapshotLabels(update: any): LocationLabel[] {
    // deno-lint-ignore no-explicit-any
    return update.poses.map(({ header, pose, name }: any) => ({
        id: name,
        label: name,
        frame_id: header.frame_id,
        position: [pose.position.x, pose.position.y, pose.position.z],
        orientation: [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
        created: header.stamp.sec * 1e9 + header.stamp.nsec,
    }))
}

/** The whole list, edited from `revision`, stamped `nowMs`. */
export function listBytes(poses: NamedPose[], revision: Revision, nowMs = Date.now()): Uint8Array {
    const stamp = stampOf(nowMs)
    return encode(UPDATE_TYPE, {
        ...revision,
        poses: poses.map(({ label, frame_id, position: [x, y, z], orientation: [qx, qy, qz, qw] }) => ({
            header: { stamp, frame_id },
            pose: { position: { x, y, z }, orientation: { x: qx, y: qy, z: qz, w: qw } },
            name: label,
        })),
    })
}

/** `list` with `location` added, or moved if its name is there (in place, so the order stays). */
export function withLocation(list: NamedPose[], location: NamedPose): NamedPose[] {
    const at = list.findIndex((one) => one.label === location.label)
    return at === -1 ? [...list, location] : list.map((one, index) => (index === at ? location : one))
}

export const withoutLocation = (list: NamedPose[], name: string) => list.filter((one) => one.label !== name)

/** `list` with `from` called `to`, where it was. */
export const renamedLocation = (list: NamedPose[], from: string, to: string) => list.map((one) => (one.label === from ? { ...one, label: to } : one))

export const stringBytes = (data: string) => encode(STRING_TYPE, { data })

/** A goal at `location`'s position, in its frame, stamped `nowMs`. */
export function goalBytes({ frame_id, position: [x, y, z] }: NamedPose, nowMs = Date.now()): Uint8Array {
    return encode(POINT_STAMPED, { header: { stamp: stampOf(nowMs), frame_id }, point: { x, y, z } })
}

/** Whether `next` replaces a cache of `cached`: anything but an older revision of the same run. */
export const replaces = (cached: Revision | null, next: Revision) => !cached || cached.server_id !== next.server_id || next.seq_num >= cached.seq_num

export class NamedLocations {
    readonly state = new Store<{ locations: LocationLabel[] | null; revision: Revision | null }>({ locations: null, revision: null })

    constructor(readonly connection: Connection) {
        const subscription = connection.subscribe(SNAPSHOT_KEY, { delivery: "reliable" }, (message) => {
            const list = readList(message.bytes)
            if (replaces(this.state.get().revision, list.revision)) {
                this.state.set(list)
            }
        })
        let state = connection.status.get().state
        connection.status.subscribe(() => {
            const next = connection.status.get().state
            // each (re)connect asks for the snapshot once its subscription is up, so the answer can't miss it
            if (next === "connected" && state !== "connected") {
                subscription.ready().then(() => this.#put(REQUEST_KEY, stringBytes(""))).catch(() => {})
            }
            state = next
        })
    }

    async #put(key: string, bytes: Uint8Array) {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            throw new Error("not connected to the gateway")
        }
        await client.put(key, bytes)
    }

    /** The list now (empty before one came). */
    get current(): NamedPose[] {
        return this.state.get().locations ?? []
    }

    /** The frame the module keeps its list in (its locations'), or null while the list is empty. */
    get frame(): string | null {
        return this.current[0]?.frame_id ?? null
    }

    /** Publishes a new whole list, edited from the cached revision; it's drawn when it comes back on the topic, like anyone's. */
    publish(list: NamedPose[]): Promise<void> {
        const revision = this.state.get().revision
        if (!revision) {
            return Promise.reject(new Error("no list from the named locations module yet"))
        }
        return this.#put(SNAPSHOT_KEY, listBytes(list, revision))
    }

    /** Sends the robot to a location: its pose on /goal, in its frame (a command: the drive lease covers it). */
    goTo(name: string): Promise<void> {
        const location = this.current.find((one) => one.label === name)
        if (!location) {
            return Promise.reject(new Error(`no location named “${name}”`))
        }
        this.connection.command(GOAL_KEY)
        return this.#put(GOAL_KEY, goalBytes(location))
    }
}
