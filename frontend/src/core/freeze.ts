// Pausing the 3D view (ui/ScenePanel.tsx, LayerManager.setFrozen): while frozen, the messages its layers subscribe to are
// held instead of drawn, so the scene stays as it was while the camera still orbits. Resuming hands each subscription
// what it missed (its newest message; every one for a reliable subscription, whose messages build on each other) and
// runs live again.
import { Store } from "./store.ts"
import type { Connection, LiveHandle, SubscribeOptions } from "./transport.ts"

/** a held subscription's callback; `release()` forgets what it holds (it unsubscribed) */
export type Gated<T> = ((message: T) => void) & { release(): void }

export class MessageHold {
    readonly state = new Store<{ frozen: boolean; since: number | null }>({ frozen: false, since: null })
    /** per held subscription: hands it what it missed */
    #replays = new Map<symbol, () => void>()

    get frozen(): boolean {
        return this.state.get().frozen
    }

    /** `onMessage` passed through while live, held while frozen: only the newest, or (reliable) every one in order. */
    gate<T>(reliable: boolean, onMessage: (message: T) => void): Gated<T> {
        const id = Symbol()
        let held: T[] = []
        const gated = (message: T) => {
            if (!this.frozen) {
                onMessage(message)
                return
            }
            held = reliable ? [...held, message] : [message]
            this.#replays.set(id, () => {
                const missed = held
                held = []
                for (const one of missed) {
                    onMessage(one)
                }
            })
        }
        return Object.assign(gated, {
            release: () => {
                held = []
                this.#replays.delete(id)
            },
        })
    }

    setFrozen(frozen: boolean, now = Date.now()) {
        if (frozen === this.frozen) {
            return
        }
        this.state.set({ frozen, since: frozen ? now : null })
        if (!frozen) {
            const replays = [...this.#replays.values()]
            this.#replays.clear()
            for (const replay of replays) {
                replay()
            }
        }
    }

    /** `connection` with every subscription made through it gated (everything else is the connection's own). */
    wrap(connection: Connection): Connection {
        const subscribe = (key: string, options: SubscribeOptions, onMessage: Parameters<Connection["subscribe"]>[2]): LiveHandle => {
            const gated = this.gate(options.delivery === "reliable", onMessage)
            const handle = connection.subscribe(key, options, gated)
            return Object.assign(() => {
                gated.release()
                handle()
            }, handle)
        }
        return new Proxy(connection, {
            get(target, property) {
                if (property === "subscribe") {
                    return subscribe
                }
                const value = Reflect.get(target, property, target)
                return typeof value === "function" ? value.bind(target) : value
            },
        })
    }
}
