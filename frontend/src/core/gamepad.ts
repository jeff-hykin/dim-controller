// Driving from a gamepad (the Gamepad API: Xbox, PlayStation, Steam Deck, anything with the standard mapping; other
// pads are read with the common layout, sticks on axes 0-3). Kept free of the DOM so it's tested (test/gamepad.test.ts):
// ui/useGamepad.ts polls navigator.getGamepads() into GamepadDriver.poll and calls release() on blur / a hidden tab.
//   left stick   forward / back, plus strafe for formats that strafe (like the phone's left thumb)
//   right stick  turn (x), plus up / down for formats with a vertical axis
//   RB (held)    boost, like Shift
//   LT + RT      STOP: everything stops now, and the pad's driving holds until A
//   A            confirm: after LT + RT, drive again (from the sticks at rest); with driving held (latency, link lost),
//                Reconnect; otherwise it presses the focused button (a dialog's)
// Safety: nothing drives until the pad's sticks have been at rest (a pad connected with a stick off center, or drifting,
// sends nothing); a disconnect, blur or hidden tab zeroes it and asks for rest again; held driving (the link watch)
// ignores it like the keys. The arm format isn't driven by a pad (its joints and end effector are keyed): there only
// LT + RT (the arm's stop) and A work.
import { DEAD_ZONE, shapeStick } from "./stick.ts"
import { persistentStore, Store } from "./store.ts"
import type { Axes, RobotProfile } from "../profile/types.ts"

/** The slice of a browser Gamepad this reads (navigator.getGamepads() entries; a test passes plain objects). */
export interface PadLike {
    index: number
    id: string
    mapping: string
    connected: boolean
    axes: readonly number[]
    buttons: readonly { pressed: boolean; value: number }[]
}

export interface GamepadSettings {
    /** share of a stick's travel that sends nothing (drift) */
    deadZone: number
    /** up on the left stick backs up */
    invertY: boolean
}

export const GAMEPAD_DEFAULTS: GamepadSettings = { deadZone: 0.15, invertY: false }
export const gamepadSettings = persistentStore<GamepadSettings>("lv.gamepad", GAMEPAD_DEFAULTS)

/** what the status strip shows */
export interface GamepadStatus {
    connected: boolean
    id: string
    /** sticks seen at rest since connect / the last stop: input is accepted */
    ready: boolean
    /** LT + RT pressed: the pad holds until A */
    stopped: boolean
}

/** standard mapping button indexes (w3.org/TR/gamepad: A, RB, LT, RT) */
const BUTTON = { a: 0, rb: 5, lt: 6, rt: 7 } as const
/** a trigger counts as pulled past this */
const TRIGGER = 0.5

/** Which drive axes a format uses beyond forward and turn (the same test as its keys: ui/DriveHud.tsx). */
export function profileAxes(profile: RobotProfile): { strafe: boolean; vertical: boolean } {
    const actions = Object.values(profile.drive.keys)
    return {
        strafe: actions.some((action) => "axis" in action && action.axis === "strafe"),
        vertical: actions.some((action) => "axis" in action && action.axis === "vertical"),
    }
}

/** The pad's buttons and sticks as this reads them (a non-standard pad, e.g. a raw Steam Deck: the common layout). */
export function readPad(pad: PadLike): { lx: number; ly: number; rx: number; ry: number; a: boolean; rb: boolean; lt: boolean; rt: boolean } {
    const axis = (index: number) => Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0
    const button = (index: number) => {
        const entry = pad.buttons[index]
        return !!entry && (entry.pressed || entry.value > TRIGGER)
    }
    return { lx: axis(0), ly: axis(1), rx: axis(2), ry: axis(3), a: button(BUTTON.a), rb: button(BUTTON.rb), lt: button(BUTTON.lt), rt: button(BUTTON.rt) }
}

/** The drive axes for the sticks (raw -1..1, y down as the API reports it), shaped with a dead zone and expo. */
export function padAxes(pad: { lx: number; ly: number; rx: number; ry: number }, profile: RobotProfile, settings: GamepadSettings): Partial<Axes> {
    const { strafe, vertical } = profileAxes(profile)
    const deadZone = clampDeadZone(settings.deadZone)
    const left = shapeStick(pad.lx, settings.invertY ? -pad.ly : pad.ly, 1, strafe ? "xy" : "y", deadZone)
    const right = shapeStick(pad.rx, pad.ry, 1, vertical ? "xy" : "x", deadZone)
    return { forward: left.y, strafe: strafe ? clean(-left.x) : 0, turn: clean(-right.x), vertical: vertical ? right.y : 0 }
}

const clean = (value: number) => value || 0
const clampDeadZone = (value: number) => Number.isFinite(value) ? Math.min(0.5, Math.max(0.02, value)) : DEAD_ZONE

/** every stick inside the dead zone and both triggers out */
export function atRest(pad: { lx: number; ly: number; rx: number; ry: number; lt: boolean; rt: boolean }, deadZone: number): boolean {
    const zone = clampDeadZone(deadZone)
    return Math.hypot(pad.lx, pad.ly) <= zone && Math.hypot(pad.rx, pad.ry) <= zone && !pad.lt && !pad.rt
}

/** What the pad drives and stops (app.drive / app.arm through ui/useGamepad.ts; a test passes fakes). */
export interface PadTarget {
    profile: () => RobotProfile
    settings: () => GamepadSettings
    /** the drive's axes from this source (drive.setAxes("gamepad", ...)); ignored by the drive while held */
    setAxes: (axes: Partial<Axes>) => void
    setBoost: (boost: boolean) => void
    /** STOP, the same as Space (the drive's, or the arm's) */
    stop: () => void
    /** driving is held by the link watch (latency, link lost) */
    halted: () => boolean
    /** A while held: Reconnect */
    reconnect: () => void
    /** A otherwise: press the focused button */
    confirm: () => void
}

const ZERO: Partial<Axes> = { forward: 0, strafe: 0, turn: 0, vertical: 0 }

export const noPad = (): GamepadStatus => ({ connected: false, id: "", ready: false, stopped: false })

export class GamepadDriver {
    #index: number | null = null
    #last = { a: false, combo: false, rb: false }
    #sent = JSON.stringify(ZERO)
    #wasHalted = false

    constructor(readonly target: PadTarget, readonly status = new Store<GamepadStatus>(noPad())) {}

    /** One read of navigator.getGamepads(): the first connected pad drives. */
    poll(pads: readonly (PadLike | null)[]) {
        const pad = pads.find((other): other is PadLike => !!other && other.connected) ?? null
        if (!pad) {
            if (this.status.get().connected) {
                this.release()
                this.#index = null
                this.status.set(noPad())
            }
            return
        }
        if (pad.index !== this.#index) {
            // a new pad: nothing from it until its sticks are seen at rest
            this.release()
            this.#index = pad.index
            this.#last = { a: false, combo: false, rb: false }
            this.status.set({ connected: true, id: pad.id, ready: false, stopped: false })
        }
        const read = readPad(pad)
        const settings = this.target.settings()
        const arm = this.target.profile().type === "arm"

        // LT + RT: STOP, at once, whatever else is going on
        const combo = read.lt && read.rt
        if (combo && !this.#last.combo) {
            this.#zero()
            this.target.stop()
            this.status.update({ stopped: true, ready: false })
        }
        // A: resume after LT + RT, Reconnect while held, else the focused button
        if (read.a && !this.#last.a) {
            if (this.target.halted()) {
                this.target.reconnect()
            } else if (this.status.get().stopped) {
                this.status.update({ stopped: false, ready: false })
            } else {
                this.target.confirm()
            }
        }
        this.#last.a = read.a
        this.#last.combo = combo

        // held by the link watch: input ignored, and once it lets go, only from the sticks at rest
        const halted = this.target.halted()
        if (halted && !this.#wasHalted) {
            this.#zero()
            this.status.update({ ready: false })
        }
        this.#wasHalted = halted

        let status = this.status.get()
        if (!status.ready && !status.stopped && atRest(read, settings.deadZone)) {
            this.status.update({ ready: true })
            status = this.status.get()
        }
        if (arm || halted || status.stopped || !status.ready) {
            this.#zero()
            return
        }
        if (read.rb !== this.#last.rb) {
            this.#last.rb = read.rb
            this.target.setBoost(read.rb)
        }
        this.#send(padAxes(read, this.target.profile(), settings))
    }

    /** Blur, a hidden tab, a disconnect: zero now, and nothing again until the sticks are at rest. */
    release() {
        this.#zero()
        if (this.#last.rb) {
            this.#last.rb = false
            this.target.setBoost(false)
        }
        if (this.status.get().connected) {
            this.status.update({ ready: false })
        }
    }

    #zero() {
        this.#send(ZERO)
    }

    #send(axes: Partial<Axes>) {
        const key = JSON.stringify(axes)
        if (key !== this.#sent) {
            this.#sent = key
            this.target.setAxes(axes)
        }
    }
}

/** The pad's controls for the `?` list (ui/Overlays.tsx). */
export function gamepadBindings(profile: RobotProfile): { buttons: string; action: string }[] {
    if (profile.type === "arm") {
        return [
            { buttons: "LT + RT", action: "STOP the arm" },
            { buttons: "A", action: "confirm (the focused button)" },
            { buttons: "sticks", action: "nothing: the arm is driven from the keys and the arm panel" },
        ]
    }
    const { strafe, vertical } = profileAxes(profile)
    return [
        { buttons: "left stick", action: strafe ? "forward / back, strafe" : "forward / back" },
        { buttons: "right stick", action: vertical ? "turn, up / down" : "turn" },
        { buttons: "RB (hold)", action: "boost" },
        { buttons: "LT + RT", action: "STOP (the pad holds until A)" },
        { buttons: "A", action: "after a stop: drive again · held: Reconnect · else the focused button" },
    ]
}
