// Placing a sample by when it was taken rather than when it arrived. The two clocks sit tens of
// seconds apart *and* run at different rates, so the offset has to be read off the traffic: the
// quickest samples show the clocks' difference, and how that difference slides shows the drift.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { CaptureClock } from "../src/core/captureClock.ts"

/** The clocks' difference, as measured on the live link. */
const OFFSET = 31_842
/** How long samples spend in transit, cycled through: one quick one in every five. */
const TRANSIT = [900, 1200, 40, 870, 1580]

Deno.test("clocks that keep the same rate: the quickest sample in the window sets the offset", () => {
    const clock = new CaptureClock()
    for (let index = 0; index < 100; index++) {
        const capture = 100_000 + index * 100
        clock.takenAt(capture + OFFSET + TRANSIT[index % TRANSIT.length], capture)
    }
    assertEquals(clock.offsetMs, OFFSET + 40, "the smallest gap seen, and no drift to correct for")
    assertAlmostEquals(clock.driftMsPerSecond, 0, 1e-6)

    // a cloud that took 854 ms is placed 854 ms before it landed, not where it landed
    const capture = 110_000
    const arrival = capture + OFFSET + 854
    assertEquals(Math.round(arrival - clock.takenAt(arrival, capture)), 814, "854 ms late, minus the 40 ms floor")
})

Deno.test("a stamp clock losing 50 ms a second is still placed within a frame of when it was taken", () => {
    // What the sim actually does under load: the stamps slide ~50 ms further behind every second.
    // A window minimum reads such a series as it was a window ago -- 1.5 s stale over 30 s, which
    // is what put the scans a third of a turn behind the robot.
    const clock = new CaptureClock()
    const DRIFT = 0.05
    const offsetAt = (takenMs: number) => OFFSET + DRIFT * takenMs
    /** No rate can be read off a few seconds of traffic, so the first stretch is the old minimum. */
    const WARM_UP = 100
    let worst = 0
    let worstWarmingUp = 0
    for (let index = 0; index < 400; index++) {
        const taken = index * 100 // when it was really taken, on the arrival clock
        const capture = taken - offsetAt(taken)
        const arrival = taken + TRANSIT[index % TRANSIT.length]
        const off = Math.abs(clock.takenAt(arrival, capture) - taken)
        if (index >= WARM_UP) {
            worst = Math.max(worst, off)
        } else {
            worstWarmingUp = Math.max(worstWarmingUp, off)
        }
    }
    assertAlmostEquals(clock.driftMsPerSecond, 50, 1, "the drift itself is measured, not absorbed")
    assertEquals(worst < 150, true, `placed within 150 ms of when it was taken, off by ${Math.round(worst)}`)
    // and while it is still warming up it is no worse than placing the cloud by arrival was
    assertEquals(worstWarmingUp < Math.max(...TRANSIT), true, `off by ${Math.round(worstWarmingUp)} warming up`)
})

Deno.test("no capture stamp: the arrival time, exactly as before", () => {
    const clock = new CaptureClock()
    assertEquals(clock.takenAt(1234, null), 1234)
    assertEquals(clock.takenAt(1234, undefined), 1234)
    assertEquals(clock.takenAt(1234, Number.NaN), 1234)
    assertEquals(clock.offsetMs, null, "nothing to learn from a sample with no stamp")
})

Deno.test("the first sample is usable straight away", () => {
    const clock = new CaptureClock()
    assertEquals(clock.takenAt(10_000, 1_000), 10_000, "nothing to compare against yet, so arrival")
    assertEquals(clock.offsetMs, 9_000)
    assertEquals(clock.sampleCount, 1)
    // the next one is judged against it
    assertEquals(clock.takenAt(10_500, 1_000), 10_000, "500 ms slower than the best, so pulled back")
})

Deno.test("a sample is never placed after it arrived", () => {
    const clock = new CaptureClock()
    for (const transit of [40, 60, 50]) {
        clock.takenAt(1_000 + transit, 1_000 - OFFSET)
    }
    // a long stall: the quickest sample is now old, and extrapolating it would run past the sample
    const arrival = 9_000
    assertEquals(clock.takenAt(arrival, arrival - OFFSET - 3_000) <= arrival, true)
})
