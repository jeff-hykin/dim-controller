// Moving a floating panel (a camera, the 2D map) by its header: it stays on screen, below the top bar.
import type { PointerEvent as ReactPointerEvent } from "react"

/** Drags `element` with the pointer from `event` (a header's pointerdown); `onDone` gets where it was dropped. */
export function startPanelDrag(event: ReactPointerEvent, element: HTMLElement, onDone: (x: number, y: number) => void) {
    const box = element.getBoundingClientRect()
    const offsetX = event.clientX - box.left, offsetY = event.clientY - box.top
    const move = (moved: PointerEvent) => {
        const x = Math.max(0, Math.min(innerWidth - 80, moved.clientX - offsetX))
        const y = Math.max(48, Math.min(innerHeight - 40, moved.clientY - offsetY))
        element.style.left = `${x}px`
        element.style.top = `${y}px`
        element.style.right = "auto"
        element.style.bottom = "auto"
    }
    const up = () => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        const after = element.getBoundingClientRect()
        onDone(after.left, after.top)
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
}
