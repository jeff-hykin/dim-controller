// The one connection to Desktop's zenoh-web bridge, and topic discovery. dimos names a channel
// `dimos/<topic>/<msg type>`, so the key itself says what a topic carries.
import { connect, type Message, Priority, type Publisher, type SubscribeOptions, type ZenohWeb } from "../vendor/zenoh_web/zenoh_web.ts"
import { Store } from "./store.ts"

export { Priority }
export type { Message, Publisher, SubscribeOptions }

export interface Topic {
    /** the full zenoh key, e.g. dimos/lidar/sensor_msgs.PointCloud2 */
    key: string
    /** the dimos topic name, e.g. /lidar */
    name: string
    /** the message type, e.g. sensor_msgs.PointCloud2 */
    type: string
}

/** `dimos/<name>/<type>` → Topic; anything else (wildcards, other prefixes) → null. */
export function parseKey(key: string): Topic | null {
    const parts = key.split("/")
    if (parts.length < 3 || parts[0] !== "dimos" || key.includes("*")) {
        return null
    }
    const type = parts[parts.length - 1]
    if (!/^\w+\.\w+$/.test(type)) {
        return null
    }
    return { key, name: "/" + parts.slice(1, -1).join("/"), type }
}

/** The key dimos's zenoh transport uses for a topic of a type. */
export const dimosKey = (topic: string, type: string) => `dimos/${topic.replace(/^\/+/, "")}/${type}`

export interface ConnectionState {
    state: "connecting" | "connected" | "degraded" | "lost"
    topics: Topic[]
    droppedPerSecond: number
    rttMs: number | null
    error: string | null
}

/** Ten beats a second; the bridge fires a publisher's deadman after `heartbeatMisses` silent beats. */
export const HEARTBEAT_HZ = 10
const DISCOVERY_MS = 2000

export class Connection {
    client: ZenohWeb | null = null
    readonly status = new Store<ConnectionState>({ state: "connecting", topics: [], droppedPerSecond: 0, rttMs: null, error: null })
    #subscriptions = new Set<LiveSubscription>()
    #lastDropped = 0
    #url: string
    #heartbeatMisses: number

    constructor(url: string, deadmanMs = 400) {
        this.#url = url
        this.#heartbeatMisses = Math.max(2, Math.round((deadmanMs / 1000) * HEARTBEAT_HZ))
    }

    async start() {
        while (!this.client) {
            try {
                this.client = await connect(this.#url, { heartbeatHz: HEARTBEAT_HZ, heartbeatMisses: this.#heartbeatMisses })
            } catch (error) {
                this.status.update({ state: "lost", error: String(error) })
                await new Promise((resolve) => setTimeout(resolve, 2000))
            }
        }
        const client = this.client
        this.status.update({ state: "connected", error: null })
        client.onState((state) => this.status.update({ state }))
        for (const subscription of this.#subscriptions) {
            subscription.open(client)
        }
        setInterval(() => {
            const dropped = Object.values(client.stats).reduce((sum, stats) => sum + (stats.dropped || 0), 0)
            this.status.update({ droppedPerSecond: dropped - this.#lastDropped, rttMs: client.rttMs ?? null })
            this.#lastDropped = dropped
        }, 1000)
        for (;;) {
            try {
                const found = await client.listTopics("dimos/**", { probeMs: 800 })
                const topics = found.map((topic) => parseKey(topic.key)).filter((topic): topic is Topic => topic !== null)
                topics.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
                const before = this.status.get().topics
                if (topics.length !== before.length || topics.some((topic, index) => topic.key !== before[index].key)) {
                    this.status.update({ topics })
                }
            } catch {
                // the bridge is reconnecting; the next round tries again
            }
            await new Promise((resolve) => setTimeout(resolve, DISCOVERY_MS))
        }
    }

    /** Subscribes now or once connected; the returned function unsubscribes. */
    subscribe(key: string, options: SubscribeOptions, onMessage: (message: Message) => void): () => void {
        const subscription = new LiveSubscription(key, options, onMessage)
        this.#subscriptions.add(subscription)
        if (this.client) {
            subscription.open(this.client)
        }
        return () => {
            this.#subscriptions.delete(subscription)
            subscription.close()
        }
    }

    /** Bridge clock now (ms), the clock message timestamps are in. */
    bridgeNow(): number {
        const client = this.client
        return client ? client.now() + (client.clockOffsetMs ?? 0) : performance.timeOrigin + performance.now()
    }
}

class LiveSubscription {
    #handle: { close(): void } | null = null
    constructor(readonly key: string, readonly options: SubscribeOptions, readonly onMessage: (message: Message) => void) {}
    open(client: ZenohWeb) {
        this.#handle = client.subscribe(this.key, this.options, this.onMessage)
    }
    close() {
        this.#handle?.close()
        this.#handle = null
    }
}
