// The drive loop against a fake bridge client: what gets published, when, and with which speeds.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Drive } from "../src/core/drive.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import go2 from "../src/profile/go2.ts"
import drone from "../src/profile/drone.ts"
import type { Connection } from "../src/core/transport.ts"

function fakeBridge() {
    const puts: { key: string; twist: { linear: { x: number; y: number; z: number }; angular: { z: number } } }[] = []
    const deadmen: string[] = []
    const client = {
        state: "connected",
        publisher(key: string) {
            return {
                state: "open",
                put: (bytes: Uint8Array) => puts.push({ key, twist: decode("geometry_msgs.Twist", bytes) }),
                setDeadman: () => (deadmen.push(key), Promise.resolve()),
                clearDeadman: () => Promise.resolve(),
                close() {},
            }
        },
    }
    return { connection: { client } as unknown as Connection, puts, deadmen }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.test("disarmed: nothing is ever published", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setAxes("keys", { forward: 1 })
    await wait(200)
    assertEquals(puts.length, 0)
    drive.dispose()
})

Deno.test("armed: forward at the linear speed, shift doubles linear and halves turning, a release flushes zeros then goes quiet", async () => {
    localStorage.clear()
    const { connection, puts, deadmen } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.setArmed(true)
    drive.setAxes("keys", { forward: 1, turn: 1 })
    await wait(150)
    const plain = puts.at(-1)!
    assertEquals(plain.key, "dimos/cmd_vel/geometry_msgs.Twist")
    assertAlmostEquals(plain.twist.linear.x, go2.drive.speeds.linear)
    assertAlmostEquals(plain.twist.angular.z, go2.drive.speeds.angular)
    assertEquals(deadmen, ["dimos/cmd_vel/geometry_msgs.Twist"])
    drive.setBoost(true)
    await wait(120)
    const boosted = puts.at(-1)!
    assertAlmostEquals(boosted.twist.linear.x, go2.drive.speeds.linear * 2)
    assertAlmostEquals(boosted.twist.angular.z, go2.drive.speeds.angular * 0.5)
    drive.setBoost(false)
    drive.setAxes("keys", {})
    await wait(1300)
    const count = puts.length
    assert(puts.slice(-5).every((put) => put.twist.linear.x === 0 && put.twist.angular.z === 0))
    await wait(300)
    assertEquals(puts.length, count, "quiet after the stop flush")
    drive.dispose()
})

Deno.test("auto drives every entry point, each with its own deadman; a list in the settings wins", async () => {
    localStorage.clear()
    const { connection, puts, deadmen } = fakeBridge()
    const drive = new Drive(connection, go2)
    // no metadata: the standard set
    assertEquals(drive.state.get().topics.map((topic) => topic.topic), ["/cmd_vel", "/tele_cmd_vel"])
    drive.setArmed(true)
    drive.setAxes("keys", { forward: 1 })
    await wait(150)
    assertEquals(new Set(puts.map((put) => put.key)), new Set(["dimos/cmd_vel/geometry_msgs.Twist", "dimos/tele_cmd_vel/geometry_msgs.Twist"]))
    assertEquals(deadmen.sort(), ["dimos/cmd_vel/geometry_msgs.Twist", "dimos/tele_cmd_vel/geometry_msgs.Twist"])
    drive.settings.update({ topics: ["/mine"] })
    assertEquals(drive.state.get().topic, "/mine")
    puts.length = 0
    await wait(150)
    // the topics left behind get one zero (their stop), then only the new one moves
    assertEquals(new Set(puts.filter((put) => put.twist.linear.x !== 0).map((put) => put.key)), new Set(["dimos/mine/geometry_msgs.Twist"]))
    assertEquals(puts.filter((put) => put.key !== "dimos/mine/geometry_msgs.Twist").every((put) => put.twist.linear.x === 0), true)
    drive.dispose()
})

Deno.test("a drone profile's Q/E-style vertical axis lands in linear.z", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, drone)
    drive.setArmed(true)
    drive.setAxes("keys", { vertical: 1 })
    await wait(120)
    assertAlmostEquals(puts.at(-1)!.twist.linear.z, drone.drive.speeds.vertical)
    drive.dispose()
})

Deno.test("arming comes from the backend's drive events (another page, the agent), and so do its commands", async () => {
    localStorage.clear()
    const { connection, puts } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setRunning({ bp: [{ streams: [{ name: "cmd_vel", type: "dimos.msgs.geometry_msgs.Twist.Twist", direction: "in" }] }] })
    drive.applyEvent({ armed: true, armedBy: "agent", command: null })
    assertEquals([drive.state.get().armed, drive.state.get().armedBy], [true, "agent"])
    drive.setAxes("keys", { forward: 1 })
    await wait(150)
    assert(puts.length > 0, "keys drive once armed elsewhere")
    const command = { key: "dimos/cmd_vel/geometry_msgs.Twist", linear: [0.3, 0, 0] as [number, number, number], angular: [0, 0, 0] as [number, number, number], seconds: 1, dryRun: true, source: "agent" }
    drive.applyEvent({ armed: true, armedBy: "agent", command })
    assertEquals(drive.state.get().command, command)
    drive.applyEvent({ armed: false, armedBy: null, command: null })
    assertEquals([drive.state.get().armed, drive.state.get().command], [false, null])
    const count = puts.length
    await wait(200)
    assertEquals(puts.length, count, "disarmed: quiet")
    drive.dispose()
})
