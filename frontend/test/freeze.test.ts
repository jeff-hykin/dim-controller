// Pausing the 3D view (core/freeze.ts, LayerManager.setFrozen): while paused, layers' messages are held (the newest, or
// every one for a reliable subscription) and their per-frame updates stop; resuming hands over what was missed and
// runs live; an unsubscribed layer is never handed anything.
import { assertEquals } from "jsr:@std/assert@1"
import { MessageHold } from "../src/core/freeze.ts"
import { LayerManager } from "../src/core/layers/manager.ts"
import { registerLayer } from "../src/core/layers/registry.ts"
import { Store } from "../src/core/store.ts"
import type { Connection, SubscribeOptions, Topic } from "../src/core/transport.ts"

Deno.test("held: the newest message for a latest subscription, every one in order for a reliable one", () => {
    const hold = new MessageHold()
    const latest: number[] = [], reliable: number[] = []
    const toLatest = hold.gate(false, (message: number) => latest.push(message))
    const toReliable = hold.gate(true, (message: number) => reliable.push(message))
    toLatest(1)
    toReliable(1)
    hold.setFrozen(true, 1000)
    assertEquals(hold.state.get(), { frozen: true, since: 1000 })
    for (const message of [2, 3, 4]) {
        toLatest(message)
        toReliable(message)
    }
    assertEquals([latest, reliable], [[1], [1]], "nothing reaches a layer while paused")
    hold.setFrozen(false)
    assertEquals([latest, reliable], [[1, 4], [1, 2, 3, 4]])
    toLatest(5)
    assertEquals(latest, [1, 4, 5], "live again")
    hold.setFrozen(true)
    hold.setFrozen(false)
    assertEquals(latest, [1, 4, 5], "nothing missed, nothing replayed")
})

Deno.test("a released subscription is handed nothing on resume", () => {
    const hold = new MessageHold()
    const got: number[] = []
    const gated = hold.gate(false, (message: number) => got.push(message))
    hold.setFrozen(true)
    gated(1)
    gated.release()
    hold.setFrozen(false)
    assertEquals(got, [])
})

const TEST_TYPE = "test_msgs.Freeze"
const topic: Topic = { key: `dimos/freeze/${TEST_TYPE}`, name: "/freeze", type: TEST_TYPE }

Deno.test("a paused 3D view holds its layers' messages and frame updates, and resumes them", () => {
    const subscriptions: { options: SubscribeOptions; deliver: (message: unknown) => void; open: boolean }[] = []
    const status = new Store<{ topics: Topic[] }>({ topics: [] })
    const connection = {
        status,
        subscribe(_key: string, options: SubscribeOptions, onMessage: (message: unknown) => void) {
            const entry = { options, deliver: onMessage, open: true }
            subscriptions.push(entry)
            return () => (entry.open = false)
        },
    } as unknown as Connection
    const frames: ((frame: unknown) => void)[] = []
    const viewer = { scene: { add: () => {}, remove: () => {} }, onFrame: (listener: (frame: unknown) => void) => frames.push(listener), requestRender: () => {} }
    const drawn: unknown[] = []
    let updates = 0
    registerLayer({
        id: "freeze-test",
        label: "Freeze test",
        types: [TEST_TYPE],
        defaults: {},
        create(context, layerTopic) {
            const stop = context.connection.subscribe(layerTopic.key, { delivery: "latest" }, (message) => drawn.push(message))
            return { root: { traverse: () => {} } as never, update: () => updates++, dispose: stop }
        },
    })
    const manager = new LayerManager(viewer as never, { lookup: () => null } as never, {} as never, connection, {} as never, {} as never)
    status.set({ topics: [topic] })
    // the newest subscription is the layer's (the URDF request comes first)
    const layer = subscriptions.at(-1)!
    layer.deliver("a")
    frames.forEach((frame) => frame({}))
    assertEquals([drawn, updates], [["a"], 1])

    manager.setFrozen(true)
    layer.deliver("b")
    layer.deliver("c")
    frames.forEach((frame) => frame({}))
    assertEquals([drawn, updates], [["a"], 1], "paused: the scene stays as it was")
    assertEquals(layer.open, true, "still subscribed, so resuming is instant")

    manager.setFrozen(false)
    assertEquals(drawn, ["a", "c"], "resumed: the newest message it missed, then live")
    frames.forEach((frame) => frame({}))
    assertEquals(updates, 2)
    // a hidden 3D view lets go of the URDF source, stopping its timers
    manager.paused.set({ paused: true })
})
