// A setting as − value + (exact presses instead of dragging a slider), for speeds, dead zones and other tuning values.
import { Button } from "dimos-react"

export function Stepper({ label, min, max, step, value, format, disabled, onChange }: { label: string; min: number; max: number; step: number; value: number; format: (value: number) => string; disabled?: boolean; onChange: (value: number) => void }) {
    // snapped to the step's grid from min, so float drift never shows (0.30000000000000004)
    const move = (direction: number) => onChange(Math.min(max, Math.max(min, min + Math.round((value + direction * step - min) / step) * step)))
    const epsilon = step * 1e-6
    return (
        <span className="speed-stepper">
            <Button className="dr-btn--icon" aria-label={`${label} down`} disabled={disabled || value <= min + epsilon} onClick={() => move(-1)}>−</Button>
            <span className="speed-value">{format(value)}</span>
            <Button className="dr-btn--icon" aria-label={`${label} up`} disabled={disabled || value >= max - epsilon} onClick={() => move(1)}>+</Button>
        </span>
    )
}
