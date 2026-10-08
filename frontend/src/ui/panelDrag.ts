// Moving a floating panel (a camera, the 2D map) by its header: it stays on screen, below the top bar.
import type { PointerEvent as ReactPointerEvent } from "react"

/** the top bar's height: a panel's header never goes under it */
export const TOP_BAR_PX = 48
/** how much of a panel always stays on screen (its header's left part) */
const KEEP_VISIBLE_X = 80, KEEP_VISIBLE_Y = 40

/** Drags `element` with the pointer from `event` (a header's pointerdown); `onDone` gets where it was dropped. */
export function startPanelDrag(event: ReactPointerEvent, element: HTMLElement, onDone: (x: number, y: number) => void) {
    const box = element.getBoundingClientRect()
    const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top
    let moved = false
    const move = (pointer: PointerEvent) => {
        moved = true
        const x = Math.max(0, Math.min(innerWidth - KEEP_VISIBLE_X, pointer.clientX - offsetX))
        const y = Math.max(TOP_BAR_PX, Math.min(innerHeight - KEEP_VISIBLE_Y, pointer.clientY - offsetY))
        element.style.left = `${x}px`
        element.style.top = `${y}px`
        element.style.right = "auto"
        element.style.bottom = "auto"
    }
    const up = () => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        if (!moved) {
            return
        }
        // hand the edges back to React: a right/bottom left inline would outlive the drag (React never set them, so it
        // never clears them) and squash the panel when it goes fullscreen (inset: … 0 0 0 loses to an inline "auto")
        element.style.right = ""
        element.style.bottom = ""
        const after = element.getBoundingClientRect()
        onDone(after.left, after.top)
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
}

export interface PanelBox {
    /** -1: the panel's default corner */
    x: number
    y: number
    width: number
    height: number
}

/**
 * A remembered panel box made safe for this window: a size that fits (at least the minimum), a position that keeps
 * the header reachable (on screen, below the top bar); anything not a finite number goes back to its default.
 */
export function clampPanelBox(box: Partial<PanelBox>, defaults: PanelBox, viewport: { width: number; height: number }, minimum: { width: number; height: number }): PanelBox {
    const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback
    const viewWidth = viewport.width > 0 ? viewport.width : 1280, viewHeight = viewport.height > 0 ? viewport.height : 800
    const width = Math.round(Math.max(minimum.width, Math.min(Math.max(minimum.width, viewWidth - 16), finite(box.width, defaults.width))))
    const height = Math.round(Math.max(minimum.height, Math.min(Math.max(minimum.height, viewHeight - TOP_BAR_PX - 8), finite(box.height, defaults.height))))
    const x = finite(box.x, defaults.x), y = finite(box.y, defaults.y)
    if (x < 0 || y < 0) {
        return { x: -1, y: -1, width, height }
    }
    return {
        x: Math.round(Math.max(0, Math.min(viewWidth - KEEP_VISIBLE_X, x))),
        y: Math.round(Math.max(TOP_BAR_PX, Math.min(viewHeight - KEEP_VISIBLE_Y, y))),
        width,
        height,
    }
}
