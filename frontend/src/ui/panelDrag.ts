// Moving and resizing a floating panel (a camera, the 2D map, the 3D picture-in-picture) by its header and corner: it
// stays on screen, below the top bar. And where a panel's popover menu goes.
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react"

/** the top bar's height: a panel's header never goes under it */
export const TOP_BAR_PX = 48
/** every panel's header (ui/Panel.tsx): a panel is this plus its body */
export const PANEL_HEAD_PX = 33
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

/**
 * Resizes `element` from a bottom corner (the pointer from `event`, the handle's pointerdown): "left" grows it leftward
 * (its right edge stays put), "right" rightward. With `aspect` (body height / width) the height follows the width so
 * the picture never gets bars. It stays inside the window; `onDone` gets the final box.
 */
export function startPanelResize(event: ReactPointerEvent, element: HTMLElement, options: {
    corner: "left" | "right"
    minimum: { width: number; height: number }
    aspect?: number
    onDone: (box: PanelBox) => void
}) {
    event.preventDefault()
    event.stopPropagation()
    const { corner, minimum, aspect } = options
    const box = element.getBoundingClientRect()
    const startX = event.clientX, startY = event.clientY
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    let width = box.width, height = box.height, left = box.left
    // from here on it's placed by its top-left corner, so the far edges stay put while it grows
    Object.assign(element.style, { left: `${box.left}px`, top: `${box.top}px`, right: "auto", bottom: "auto" })
    const maxWidth = corner === "left" ? box.right - 8 : innerWidth - box.left - 8
    const maxHeight = innerHeight - box.top - 8
    const move = (moved: PointerEvent) => {
        const grown = corner === "left" ? startX - moved.clientX : moved.clientX - startX
        const widest = aspect ? Math.min(maxWidth, (maxHeight - PANEL_HEAD_PX) / aspect) : maxWidth
        width = Math.round(Math.max(Math.min(minimum.width, widest), Math.min(widest, box.width + grown)))
        height = aspect
            ? Math.round(width * aspect) + PANEL_HEAD_PX
            : Math.round(Math.max(minimum.height, Math.min(maxHeight, box.height + moved.clientY - startY)))
        left = corner === "left" ? box.right - width : box.left
        Object.assign(element.style, { width: `${width}px`, height: `${height}px`, left: `${left}px` })
    }
    const up = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", up)
        handle.removeEventListener("pointercancel", up)
        // the edges back to React (as after a drag): the caller keeps the box, placed by its top-left corner
        element.style.right = ""
        element.style.bottom = ""
        options.onDone({ x: Math.round(left), y: Math.round(box.top), width, height })
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
    handle.addEventListener("pointercancel", up)
}

/**
 * A popover menu's place (fixed, so a panel's clipping never cuts it): under the button that opened it, its right edge
 * on the button's, or above the button when there's more room there; always inside the window.
 */
export function popoverPosition(anchor: Element | null | undefined, width: number, viewport = { width: globalThis.innerWidth || 1280, height: globalThis.innerHeight || 800 }): CSSProperties {
    const box = anchor?.getBoundingClientRect()
    if (!box) {
        return { position: "fixed", right: 8, top: TOP_BAR_PX + 8, width, zIndex: 40 }
    }
    const left = Math.round(Math.max(8, Math.min(box.right - width, viewport.width - width - 8)))
    const below = viewport.height - box.bottom - 8, above = box.top - TOP_BAR_PX - 8
    return below >= Math.min(320, above)
        ? { position: "fixed", left, top: Math.round(box.bottom + 4), width, maxHeight: Math.max(120, below - 4), zIndex: 40 }
        : { position: "fixed", left, bottom: Math.round(viewport.height - box.top + 4), width, maxHeight: Math.max(120, above - 4), zIndex: 40 }
}
