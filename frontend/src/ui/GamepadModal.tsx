// The gamepad chip's modal (next to STOP in the top bar): the pad that's connected, the buttons held right now, and
// basic remapping: which stick drives, inverted forward / back and turning, the dead zone, and the buttons that boost,
// stop (two held together) and confirm, each set by pressing it on the pad. Saved with the other gamepad settings
// (lv.gamepad), so every viewer on this robot drives the same way.
import { useEffect, useState } from "react"
import { useStore } from "../core/store.ts"
import { gamepadSettings, type PadLike } from "../core/gamepad.ts"
import { buttonName, DEFAULT_MAPPING, normalizeMapping, type PadMapping } from "../core/padMapping.ts"
import { gamepadStatus } from "./useGamepad.ts"
import { Button, Field, Modal, Segmented, Toggle } from "dimos-react"
import { Stepper } from "./Stepper.tsx"

type Slot = "boost" | "stop0" | "stop1" | "confirm"
const SLOT_TEXT: Record<Slot, string> = { boost: "Go fast (hold)", stop0: "Stop: first button", stop1: "Stop: second button", confirm: "Confirm / drive again" }

const connectedPad = (): PadLike | null => {
    try {
        return ([...navigator.getGamepads()] as (PadLike | null)[]).find((pad) => pad?.connected) ?? null
    } catch {
        return null
    }
}
const pressedOf = (pad: PadLike | null) => pad ? pad.buttons.flatMap((button, index) => button.pressed || button.value > 0.5 ? [index] : []) : []

export function GamepadModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const settings = useStore(gamepadSettings)
    const status = useStore(gamepadStatus)
    const mapping = normalizeMapping(settings.mapping)
    const [listening, setListening] = useState<Slot | null>(null)
    const [held, setHeld] = useState<number[]>([])
    const setMapping = (patch: Partial<PadMapping>) => gamepadSettings.update({ mapping: { ...mapping, ...patch } })
    // the held buttons, read live; while setting a slot, the first new press is its button
    useEffect(() => {
        if (!open) {
            return
        }
        let before = pressedOf(connectedPad())
        const timer = setInterval(() => {
            const now = pressedOf(connectedPad())
            setHeld((previous) => previous.join() === now.join() ? previous : now)
            const fresh = now.find((index) => !before.includes(index))
            before = now
            if (fresh === undefined) {
                return
            }
            setListening((slot) => {
                if (slot) {
                    const current = normalizeMapping(gamepadSettings.get().mapping)
                    const patch: Partial<PadMapping> = slot === "boost" ? { boost: fresh } : slot === "confirm" ? { confirm: fresh } : { stop: slot === "stop0" ? [fresh, current.stop[1]] : [current.stop[0], fresh] }
                    gamepadSettings.update({ mapping: { ...current, ...patch } })
                }
                return null
            })
        }, 40)
        return () => clearInterval(timer)
    }, [open])
    const slotValue = (slot: Slot) => slot === "boost" ? mapping.boost : slot === "confirm" ? mapping.confirm : mapping.stop[slot === "stop0" ? 0 : 1]
    return (
        <Modal open={open} onClose={() => (setListening(null), onClose())} title="Gamepad" size="md" data-testid="gamepad-modal">
            <div className="gamepad-modal">
                <p className="hint">{status.connected ? `${status.id || "A gamepad"} is connected.` : "No gamepad connected: plug one in or press a button on it."}</p>
                <div className="pad-held" aria-label="buttons held">
                    {held.length ? held.map((index) => <span key={index} className="key down">{buttonName(index)}</span>) : <span className="hint">press a button to see it here</span>}
                </div>
                <Field inline label="Driving stick" title="the stick that drives forward / back (and strafes); the other turns">
                    <Segmented size="sm" label="Driving stick" items={[["left", "Left"], ["right", "Right"]]} value={mapping.driveStick} onChange={(driveStick) => setMapping({ driveStick: driveStick as PadMapping["driveStick"] })} />
                </Field>
                <Field inline label="Invert forward / back"><Toggle value={settings.invertY} onChange={(invertY: boolean) => gamepadSettings.update({ invertY })} /></Field>
                <Field inline label="Invert turning"><Toggle value={mapping.invertTurn} onChange={(invertTurn: boolean) => setMapping({ invertTurn })} /></Field>
                <Field inline label="Dead zone" title="how far a stick moves before it drives (raise it for a drifting stick)">
                    <Stepper label="Dead zone" value={settings.deadZone} min={0.05} max={0.4} step={0.01} onChange={(deadZone) => gamepadSettings.update({ deadZone })} format={(value) => `${Math.round(value * 100)}%`} />
                </Field>
                {(Object.keys(SLOT_TEXT) as Slot[]).map((slot) => (
                    <Field inline key={slot} label={SLOT_TEXT[slot]}>
                        <Button size="sm" className="pad-assign" pressed={listening === slot} data-slot={slot} onClick={() => setListening(listening === slot ? null : slot)}>
                            {listening === slot ? "press a button…" : buttonName(slotValue(slot))}
                        </Button>
                    </Field>
                ))}
                <div className="gamepad-modal-actions">
                    <Button size="sm" disabled={JSON.stringify(mapping) === JSON.stringify(DEFAULT_MAPPING) && !settings.invertY} onClick={() => gamepadSettings.update({ mapping: DEFAULT_MAPPING, invertY: false })}>Reset to the standard layout</Button>
                </div>
            </div>
        </Modal>
    )
}
