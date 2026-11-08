// When a sample was taken, on the clock TF is kept in.
//
// A cloud carries its own capture stamp (the gateway lifts the header off an encoded message), but
// that stamp is on the sensor's clock, while TfHistory is keyed on the gateway's -- two clocks tens
// of seconds apart. Placing a cloud by its arrival time instead poses it with a transform from
// after it was taken: standing still that is invisible, turning it throws the scan around the
// robot. Measured on a loaded box, a Mid-360 scan took ~850 ms to arrive, which at 0.6 rad/s is
// close to 30 degrees of rotation the cloud never did.
//
// `arrival - capture` is the difference between the clocks plus however long that sample took to
// come. The smallest of those over a window is the sample that spent the least time in transit, so
// it is the best estimate of the clocks' difference alone -- the usual way to read an offset off a
// one-way link. Capture plus that offset is when the sample was taken, on the clock TF uses.

/** Samples kept: at ~10 Hz this is half a minute, over which a clock drifts by well under a frame. */
const WINDOW = 300

export class CaptureClock {
    readonly #gaps: number[] = []
    #offset: number | null = null

    /** Called with each sample's arrival and capture, both ms, on their own clocks. */
    observe(arrivalMs: number, captureMs: number): void {
        const gap = arrivalMs - captureMs
        if (!Number.isFinite(gap)) {
            return
        }
        this.#gaps.push(gap)
        if (this.#gaps.length > WINDOW) {
            this.#gaps.shift()
            // the dropped sample may have been the smallest, so the offset is found again
            this.#offset = null
        } else if (this.#offset === null || gap < this.#offset) {
            this.#offset = gap
            return
        }
        this.#offset ??= Math.min(...this.#gaps)
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

/** One estimate per connection: every topic crosses the same pair of clocks. */
export function captureClock(connection: object): CaptureClock {
    let clock = clocks.get(connection)
    if (!clock) {
        clock = new CaptureClock()
        clocks.set(connection, clock)
    }
    return clock
}
