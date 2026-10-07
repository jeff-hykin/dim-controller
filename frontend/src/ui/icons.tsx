// Stroke icons (24-unit grid, currentColor), from the shared dimOS set (src/dim-icons.js), plus this app's own.
import { DIM_ICON_PATHS } from "../dim-icons.js"

const OWN_ICON_PATHS: Record<string, string> = {
    // a frame with the picture letterboxed inside (bars above and below)
    fit: "M3 5h18v14H3z M6 9h12v6H6z",
    // a frame with the picture pushed out past its edges
    fill: "M3 5h18v14H3z M8 9H6v2 M16 9h2v2 M8 15H6v-2 M16 15h2v-2",
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={DIM_ICON_PATHS[name] ?? OWN_ICON_PATHS[name] ?? ""} />
        </svg>
    )
}
