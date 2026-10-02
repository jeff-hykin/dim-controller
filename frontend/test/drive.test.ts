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
    drive.setCandidates(["/cmd_vel"])
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

Deno.test("the topic: tele_cmd_vel when the robot reads it, a read topic over one only written, a chosen one wins", () => {
    localStorage.clear()
    const { connection } = fakeBridge()
    const drive = new Drive(connection, go2)
    drive.setCandidates(["/cmd_vel", "/tele_cmd_vel"])
    assertEquals(drive.state.get().topic, "/tele_cmd_vel")
    // go2-basic: the web vis module writes tele_cmd_vel but nothing reads it; the robot reads cmd_vel
    drive.setCandidates(["/cmd_vel"], ["/tele_cmd_vel"])
    assertEquals(drive.state.get().topic, "/cmd_vel")
    drive.setCandidates([], ["/robot1/cmd_vel"])
    assertEquals(drive.state.get().topic, "/robot1/cmd_vel")
    drive.settings.update({ topic: "/mine" })
    assertEquals(drive.state.get().topic, "/mine")
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
