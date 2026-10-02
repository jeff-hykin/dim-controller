// Edits how points look: style, size, color mode, gradient and range. Used by every layer that draws points.
import { GRADIENTS, gradientCss } from "../core/render/gradients.ts"
import type { PointLook } from "../core/render/pointMaterial.ts"
import { Field, NumberInput, Select, Slider } from "./controls.tsx"

export function PointLookEditor({ look, onChange }: { look: PointLook; onChange: (look: PointLook) => void }) {
    const set = (patch: Partial<PointLook>) => onChange({ ...look, ...patch })
    return (
        <>
            <Field label="Style">
                <span className="segmented">
                    {(["disc", "square", "voxel"] as const).map((style) => (
                        <button type="button" key={style} className={look.style === style ? "on" : ""} onClick={() => set({ style })}>{style}</button>
                    ))}
                </span>
            </Field>
            <Field label={look.style === "voxel" ? "Voxel" : "Size"}>
                <Slider min={0.01} max={0.5} step={0.01} value={look.size} format={(size) => `${Math.round(size * 100)} cm`} onChange={(size) => set({ size })} />
            </Field>
            <Field label="Color">
                <Select value={look.colorMode} options={[["height", "by height"], ["intensity", "by intensity"], ["range", "by distance"], ["solid", "solid"]]} onChange={(colorMode) => set({ colorMode: colorMode as PointLook["colorMode"] })} />
            </Field>
            {look.colorMode === "solid"
                ? (
                    <Field label="Solid">
                        <input type="color" value={look.solid} onChange={(event) => set({ solid: event.target.value })} />
                    </Field>
                )
                : (
                    <>
                        <div className="gradients">
                            {GRADIENTS.map((name) => (
                                <button type="button" key={name} title={name} className={`gradient-swatch ${look.gradient === name ? "on" : ""}`} style={{ background: gradientCss(name) }} onClick={() => set({ gradient: name })} />
                            ))}
                        </div>
                        {look.colorMode === "height" && (
                            <Field label="Axis">
                                <Select value={String(look.axis)} options={[["2", "z (height)"], ["0", "x"], ["1", "y"]]} onChange={(axis) => set({ axis: Number(axis) as PointLook["axis"] })} />
                            </Field>
                        )}
                        <Field label="Range" hint="empty = automatic (5th–95th percentile)">
                            <span className="range-inputs">
                                <NumberInput value={look.rangeMin} placeholder="auto" onChange={(rangeMin) => set({ rangeMin })} />
                                <NumberInput value={look.rangeMax} placeholder="auto" onChange={(rangeMax) => set({ rangeMax })} />
                            </span>
                        </Field>
                    </>
                )}
            <Field label="Opacity">
                <Slider min={0.1} max={1} step={0.05} value={look.opacity} format={(opacity) => `${Math.round(opacity * 100)}%`} onChange={(opacity) => set({ opacity })} />
            </Field>
        </>
    )
}
