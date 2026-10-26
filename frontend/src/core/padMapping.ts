// The gamepad chip's remapping (ui/GamepadModal.tsx): which stick drives, inverted turning, and which buttons boost,
// stop (a pair held together) and confirm. A pad is read through it before the driver sees it: the driver reads the
// standard layout (left stick drives, right turns; RB boosts, LT + RT stops, A confirms), so the mapping just moves
// the pad's axes and buttons into those places. Pure: test/padMapping.test.ts.
import type { PadLike } from "./gamepad.ts"

/** the standard mapping's button names by index (W3C "standard" gamepad) */
export const PAD_BUTTONS = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "L3", "R3", "Up", "Down", "Left", "Right", "Home"]
/** where the driver reads each action (dimos-react's PAD_BUTTON) */
const STANDARD = { confirm: 0, boost: 5, stopA: 6, stopB: 7 } as const

export interface PadMapping {
    /** the stick that drives (forward / back, strafe); the other turns */
    driveStick: "left" | "right"
    /** right on the turning stick turns left */
    invertTurn: boolean
    boost: number
    /** held together: STOP */
    stop: [number, number]
    confirm: number
}

export const DEFAULT_MAPPING: PadMapping = { driveStick: "left", invertTurn: false, boost: STANDARD.boost, stop: [STANDARD.stopA, STANDARD.stopB], confirm: STANDARD.confirm }

const button = (value: unknown, fallback: number) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 32 ? value as number : fallback

/** A saved mapping made safe (unknown fields default). */
export function normalizeMapping(saved: Partial<PadMapping> | null | undefined): PadMapping {
    const stop = Array.isArray(saved?.stop) ? saved.stop : []
    return {
        driveStick: saved?.driveStick === "right" ? "right" : "left",
        invertTurn: saved?.invertTurn === true,
        boost: button(saved?.boost, DEFAULT_MAPPING.boost),
        stop: [button(stop[0], DEFAULT_MAPPING.stop[0]), button(stop[1], DEFAULT_MAPPING.stop[1])],
        confirm: button(saved?.confirm, DEFAULT_MAPPING.confirm),
    }
}

export const isDefaultMapping = (mapping: PadMapping) => JSON.stringify(normalizeMapping(mapping)) === JSON.stringify(DEFAULT_MAPPING)

type PadButton = PadLike["buttons"][number]
const RELEASED: PadButton = { pressed: false, value: 0 }

/** The pad as the driver should see it: its sticks and buttons moved to the standard places by `mapping`. */
export function remapPad(pad: PadLike, mapping: PadMapping): PadLike {
    if (isDefaultMapping(mapping)) {
        return pad
    }
    const axis = (index: number) => Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0
    const [driveX, driveY, turnX, turnY] = mapping.driveStick === "left" ? [axis(0), axis(1), axis(2), axis(3)] : [axis(2), axis(3), axis(0), axis(1)]
    const axes = [driveX, driveY, mapping.invertTurn ? -turnX : turnX, turnY, ...pad.axes.slice(4)]
    const source = (index: number): PadButton => pad.buttons[index] ?? RELEASED
    // every button the mapping moves leaves its own place empty, so it doesn't also do the standard thing there
    const moved = new Set([mapping.boost, ...mapping.stop, mapping.confirm])
    const buttons: PadButton[] = pad.buttons.map((entry, index) => moved.has(index) ? RELEASED : entry)
    while (buttons.length <= STANDARD.stopB) {
        buttons.push(RELEASED)
    }
    buttons[STANDARD.boost] = source(mapping.boost)
    buttons[STANDARD.stopA] = source(mapping.stop[0])
    buttons[STANDARD.stopB] = source(mapping.stop[1])
    buttons[STANDARD.confirm] = source(mapping.confirm)
    return { ...pad, axes, buttons } as PadLike
}

/** a button's name ("RB", or "button 17" past the standard ones) */
export const buttonName = (index: number) => PAD_BUTTONS[index] ?? `button ${index}`
