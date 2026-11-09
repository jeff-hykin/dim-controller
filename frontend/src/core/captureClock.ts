// When a sample was taken, on the clock TF is kept in.
//
// A cloud carries its own capture stamp (the gateway lifts the header off an encoded message), but
// that stamp is on the sensor's clock, while TfHistory is keyed on the gateway's -- two clocks tens
// of seconds apart. Placing a cloud by its arrival time instead poses it with a transform from
// after it was taken: standing still that is invisible, turning it throws the scan around the
// robot. Measured on a loaded box, a Mid-360 scan took ~850 ms to arrive, which at 0.6 rad/s is
// close to 30 degrees of rotation the cloud never did.
//
import { UNWRAPPED } from "./freeze.ts"

// `arrival - capture` is that difference plus however long the sample took to come, so the
// quickest sample in a window is the best read of the difference alone. But the two clocks also
// run at different *rates*: measured against this sim, the stamp clock loses ~50 ms every second
// (a sim held under 1x by a loaded box stamps slower than wall time). On a series sliding like
// that the smallest gap in a window is always its oldest sample, so a plain minimum reads the
// offset as it was a window ago -- 1.5 s stale over 30 s, which placed every scan 1.5 s in the
// past and smeared it worse than no correction at all.
//
// So fit a line rather than take a point: the quickest sample of each half of the window gives two
// points on the gaps' lower envelope, and the line through them carries the rate. Extrapolated to
// now that is the offset without the window's lag. The line is anchored by real samples, so it
// still includes one transit time -- unavoidable on a one-way link -- and the newest gap caps it,
// since nothing can have been taken after it arrived.

/**
 * How much history the fit sees: long enough for a quick sample to land in each half, short enough
 * to notice the rate changing. It changes often -- the drift is the sim being starved, so it runs
 * near zero on an idle box and around 50 ms/s under load, and a window is how long this takes to
 * catch a step. Swept against one: 12 s holds steady-state error at 40 ms and costs 200 ms through
 * a step, where 20 s costs 400 ms and 30 s costs 650 ms for no better fit.
 */
const WINDOW_MS = 12_000
/** Fitted rates past this are noise, not clock drift (two slow samples in a row). */
const MAX_RATE = 0.5
/**
 * What a half of the window has to hold before its quickest sample is taken for the transit
 * floor. Two samples a moment apart differ by their transit times, not by any drift, and a rate
 * read off those two is pure noise amplified by a short span.
 */
const FIT_SAMPLES = 8
const FIT_SPAN_MS = 4_000

interface Gap {
    arrivalMs: number
    /** arrival - capture: the clocks' difference plus this sample's transit */
    gapMs: number
}

export class CaptureClock {
    readonly #gaps: Gap[] = []
    #offset: number | null = null
    #rate = 0

    /** Called with each sample's arrival and capture, both ms, on their own clocks. */
    observe(arrivalMs: number, captureMs: number): void {
        const gapMs = arrivalMs - captureMs
        if (!Number.isFinite(gapMs)) {
            return
        }
        this.#gaps.push({ arrivalMs, gapMs })
        const cutoff = arrivalMs - WINDOW_MS
        let drop = 0
        while (drop < this.#gaps.length - 2 && this.#gaps[drop].arrivalMs < cutoff) {
            drop++ // always leave two, so there is still a line to fit
        }
        if (drop > 0) {
            this.#gaps.splice(0, drop)
        }
        this.#refit(arrivalMs)
    }

    /**
     * The gaps' lower envelope, read at `nowMs`.
     *
     * Two steps, because the two unknowns come from different places. The rate comes from the
     * quickest sample of each half of the window: two points far enough apart that the clocks'
     * drift between them outweighs the difference in their transit times. The level then comes
     * from every sample, each projected to now at that rate -- so the single quickest sample in
     * the window sets it, wherever in the window it sits, which is the thing a plain minimum got
     * right. With no drift the rate fits as zero and this is exactly that minimum.
     */
    #refit(nowMs: number): void {
        const gaps = this.#gaps
        const newest = gaps[gaps.length - 1]
        if (gaps.length < 2) {
            this.#rate = 0
            this.#offset = newest.gapMs
            return
        }
        const middle = (gaps[0].arrivalMs + newest.arrivalMs) / 2
        let early: Gap | null = null
        let late: Gap | null = null
        let earlyCount = 0
        let lateCount = 0
        for (const gap of gaps) {
            if (gap.arrivalMs <= middle) {
                earlyCount++
                if (!early || gap.gapMs < early.gapMs) {
                    early = gap
                }
            } else {
                lateCount++
                if (!late || gap.gapMs < late.gapMs) {
                    late = gap
                }
            }
        }
        const span = early && late ? late.arrivalMs - early.arrivalMs : 0
        const fittable = earlyCount >= FIT_SAMPLES && lateCount >= FIT_SAMPLES && span >= FIT_SPAN_MS
        const rate = fittable ? (late!.gapMs - early!.gapMs) / span : 0
        this.#rate = Math.min(MAX_RATE, Math.max(-MAX_RATE, rate))
        let offset = newest.gapMs // nothing can have been taken after it arrived: a hard ceiling
        for (const gap of gaps) {
            const projected = gap.gapMs + this.#rate * (nowMs - gap.arrivalMs)
            if (projected < offset) {
                offset = projected
            }
        }
        this.#offset = offset
    }

    /** How many samples the estimate rests on, so a caller can tell a cold clock from a settled one. */
    get sampleCount(): number {
        return this.#gaps.length
    }

    /** How fast the two clocks are pulling apart, ms per second. Zero until a rate can be fitted. */
    get driftMsPerSecond(): number {
        return this.#rate * 1000
    }

    /** The clocks' difference (ms), or null before anything has been seen. */
    get offsetMs(): number | null {
        return this.#offset
    }

    /**
     * When this sample was taken, on the arrival clock. Falls back to arrival where there is no
     * capture stamp to work from -- which is what every reader did before, so a source without one
     * is no worse off than it was.
     */
    takenAt(arrivalMs: number, captureMs: number | null | undefined): number {
        if (captureMs == null || !Number.isFinite(captureMs)) {
            return arrivalMs
        }
        this.observe(arrivalMs, captureMs)
        return this.#offset === null ? arrivalMs : captureMs + this.#offset
    }
}

const clocks = new WeakMap<object, CaptureClock>()

/**
 * One estimate per connection: every topic crosses the same pair of clocks.
 *
 * Keyed on the connection underneath any freeze wrapper. A layer subscribes through a wrapped
 * connection and everything else holds the real one, so keying on whatever the caller happens to
 * have hands them separate estimates of the same pair of clocks -- and leaves one of them empty,
 * which is exactly as confusing as it sounds when you go looking.
 */
export function captureClock(connection: object): CaptureClock {
    const key = (connection as Record<symbol, object>)[UNWRAPPED] ?? connection
    let clock = clocks.get(key)
    if (!clock) {
        clock = new CaptureClock()
        clocks.set(key, clock)
    }
    return clock
}
