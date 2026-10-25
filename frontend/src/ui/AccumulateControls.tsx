// A layer row's accumulate checkbox and, when on, how many of the newest messages to keep (point clouds, graphs).
import { Checkbox, NumberInput } from "dimos-react"
import { type Store, useStore } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"

export interface AccumulateSettings {
    mode: "latest" | "accumulate"
    frames?: number
}

export function AccumulateControls<Settings extends AccumulateSettings>({ settings, what = "scans" }: { settings: Store<Settings>; topic: Topic; what?: string }) {
    const value = useStore(settings)
    const on = value.mode === "accumulate"
    return (
        <span className="layer-row-controls">
            <Checkbox
                label="accumulate"
                title={`keep the newest ${what} instead of only the last one`}
                value={on}
                onChange={(checked: boolean) => settings.update({ mode: checked ? "accumulate" : "latest" } as Partial<Settings>)}
            />
            {on && (
                <NumberInput
                    className="number accumulate-frames"
                    step={1}
                    min={1}
                    title={`${what} kept (the newest)`}
                    aria-label={`${what} to accumulate`}
                    value={value.frames ?? 10}
                    onChange={(frames: number | null) => settings.update({ frames: Math.max(1, Math.round(frames ?? 10)) } as Partial<Settings>)}
                />
            )}
        </span>
    )
}
