// Placing a sample by when it was taken rather than when it arrived. The two clocks sit tens of
// seconds apart, so the offset has to be read off the traffic: the sample that spent the least
// time in transit is the one that shows the clocks' difference alone.
import { assertEquals } from "jsr:@std/assert@1"
import { CaptureClock } from "../src/core/captureClock.ts"

Deno.test("the quickest sample sets the offset, and slow ones are pulled back to when they were taken", () => {
    const clock = new CaptureClock()
    const OFFSET = 31_842 // the clocks' difference, as measured on the live link

    // a burst where the best sample got through with almost no delay
    for (const transit of [900, 1200, 40, 870, 1580]) {
        clock.takenAt(OFFSET + transit + 1000, 1000)
    }
    // the gap is the clocks' difference plus transit, so the best sample reads OFFSET + its 40 ms
    assertEquals(clock.offsetMs, OFFSET + 40, "the smallest gap seen is the offset estimate")

    // a cloud that took 854 ms is placed 854 ms before it landed, not where it landed
    const capture = 5_000
    const arrival = capture + OFFSET + 854
    assertEquals(Math.round(arrival - clock.takenAt(arrival, capture)), 814, "854 ms late, minus the 40 ms floor")
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
    // the next one is judged against it
    assertEquals(clock.takenAt(10_500, 1_000), 10_000, "500 ms slower than the best, so pulled back")
})

Deno.test("a better sample lowers the offset, and the estimate follows the clocks rather than the traffic", () => {
    const clock = new CaptureClock()
    clock.takenAt(1_000 + 500, 1_000)
    assertEquals(clock.offsetMs, 500)
    clock.takenAt(2_000 + 120, 2_000)
    assertEquals(clock.offsetMs, 120, "a quicker sample is a better read of the offset")
    clock.takenAt(3_000 + 900, 3_000)
    assertEquals(clock.offsetMs, 120, "a slow one does not drag it back up")
})
