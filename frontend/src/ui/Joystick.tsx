// A touch/mouse stick: the knob's offset from center becomes x and y in -1..1 (up = +y); release recenters.
import { useRef, useState } from "react"

export function Joystick({ label, onMove, size = 132 }: { label: string; onMove: (x: number, y: number) => void; size?: number }) {
    const base = useRef<HTMLDivElement>(null)
    const [knob, setKnob] = useState({ x: 0, y: 0 })
    const pointer = useRef<number | null>(null)
    const radius = size / 2

    const move = (event: React.PointerEvent) => {
        if (pointer.current !== event.pointerId) {
            return
        }
        const box = base.current!.getBoundingClientRect()
        let dx = event.clientX - (box.left + radius)
        let dy = event.clientY - (box.top + radius)
        const length = Math.hypot(dx, dy)
        if (length > radius) {
            dx *= radius / length
            dy *= radius / length
        }
        setKnob({ x: dx, y: dy })
        // a little dead zone so a resting thumb sends nothing
        const dead = (value: number) => Math.abs(value) < 0.08 ? 0 : value
        onMove(dead(dx / radius), dead(-dy / radius))
    }
    const release = (event: React.PointerEvent) => {
        if (pointer.current !== event.pointerId) {
            return
        }
        pointer.current = null
        setKnob({ x: 0, y: 0 })
        onMove(0, 0)
    }
    return (
        <div
            ref={base}
            className="joystick"
            style={{ width: size, height: size }}
            aria-label={label}
            onPointerDown={(event) => {
                pointer.current = event.pointerId
                base.current!.setPointerCapture(event.pointerId)
                move(event)
            }}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
        >
            <span className="joystick-label">{label}</span>
            <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
        </div>
    )
}
