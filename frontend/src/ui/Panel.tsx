// Every panel's chrome (the camera, the 2D map, the 3D view, and the Tiles layout's status and settings): a header with
// its title and buttons, the body, and how it's placed:
//  - "float": Classic's floating panel, moved by its header and resized from the corner facing into the screen
//  - "dock": a layout (ui/layout.ts) places it at `rect`; its maximize button fills the page with it
//  - "main": fills the page behind everything (Classic's fullscreen camera or map)
// Folding (the map) and turning off (the 3D view) are the caller's buttons in `head`.
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, useRef } from "react"
import { Icon } from "./icons.tsx"
import type { Rect, Region } from "./layout.ts"
import { swapTiles } from "./layout.ts"
import { startPanelDrag, startPanelResize, type PanelBox } from "./panelDrag.ts"

export type Placement = "float" | "dock" | "main"

/** A docked panel's part of the layout: its box, whether it's hidden or maximized, and how the header moves it. */
export interface Dock {
    region: Region
    rect: Rect | null
    maximized: boolean
    onMaximize: () => void
    /** Tiles: dropping the header on another tile swaps them */
    tiles?: { order: Region[]; onOrder: (order: Region[]) => void }
}

export function Panel({ placement, dock, className = "", style, testid, title, head, children, bodyClassName = "", bodyOnClick, onHeadDoubleClick, onDrag, resize, panelRef }: {
    placement: Placement
    dock?: Dock | null
    className?: string
    /** float: where it is and how big */
    style?: CSSProperties
    testid?: string
    /** the header's tooltip */
    title?: string
    head: ReactNode
    children?: ReactNode
    bodyClassName?: string
    bodyOnClick?: () => void
    onHeadDoubleClick?: () => void
    /** float: the header drag ended here */
    onDrag?: (x: number, y: number) => void
    /** float: the corner handle (null: none) */
    resize?: { corner: "left" | "right"; minimum: { width: number; height: number }; aspect?: number; onDone: (box: PanelBox) => void } | null
    panelRef?: Ref<HTMLDivElement>
}) {
    const element = useRef<HTMLDivElement | null>(null)
    const setRef = (node: HTMLDivElement | null) => {
        element.current = node
        if (typeof panelRef === "function") {
            panelRef(node)
        } else if (panelRef) {
            ;(panelRef as { current: HTMLDivElement | null }).current = node
        }
    }
    const fromControl = (event: ReactPointerEvent) => !!(event.target as HTMLElement).closest("button, select, input, label, [role=tab]")

    const startHeadDrag = (event: ReactPointerEvent) => {
        if (fromControl(event) || event.button !== 0) {
            return
        }
        if (placement === "float" && onDrag) {
            startPanelDrag(event, element.current!, onDrag)
        } else if (placement === "dock" && dock?.tiles && !dock.maximized) {
            startTileSwap(event, dock.region, dock.tiles)
        }
    }

    const docked = placement === "dock"
    const hidden = docked && !dock?.rect
    const placed: CSSProperties = docked
        ? dock?.rect ? { left: dock.rect.x, top: dock.rect.y, width: dock.rect.width, height: dock.rect.height } : {}
        : style ?? {}
    const classes = ["dim-panel", "camera-panel", "lv-panel", placement === "float" ? "floating" : placement, hidden ? "hidden" : "", dock?.maximized ? "maximized" : "", dock?.tiles ? "tile" : "", className]
    return (
        <div ref={setRef} className={classes.filter(Boolean).join(" ")} style={placed} data-testid={testid} data-region={dock?.region} aria-hidden={hidden || undefined}>
            <div className="camera-head" onPointerDown={startHeadDrag} onDoubleClick={(event) => !(event.target as HTMLElement).closest("button, select, input") && (docked ? dock?.onMaximize() : onHeadDoubleClick?.())} title={title}>
                {head}
                {docked && dock && (
                    <button type="button" className="dim-btn icon icon-button panel-maximize" aria-pressed={dock.maximized} title={dock.maximized ? "Back to the layout" : "Maximize (fill the page)"} aria-label={dock.maximized ? "Restore" : "Maximize"} onClick={dock.onMaximize}>
                        <Icon name={dock.maximized ? "fullscreen-exit" : "fullscreen"} size={15} />
                    </button>
                )}
            </div>
            <div className={`camera-body ${bodyClassName}`} onClick={bodyOnClick}>{children}</div>
            {placement === "float" && resize && (
                <div
                    className={`camera-resize ${resize.corner}`}
                    title="Drag to resize"
                    aria-label="Resize"
                    onPointerDown={(event) => startPanelResize(event, element.current!, resize)}
                />
            )}
        </div>
    )
}

/** Tiles: a header dragged onto another tile swaps the two (the tile under the pointer lights up on the way). */
function startTileSwap(event: ReactPointerEvent, region: Region, tiles: NonNullable<Dock["tiles"]>) {
    const startX = event.clientX, startY = event.clientY
    let target: HTMLElement | null = null
    const tileAt = (x: number, y: number) => document.elementsFromPoint(x, y).map((node) => (node as HTMLElement).closest?.<HTMLElement>("[data-region].tile")).find((tile) => tile && tile.dataset.region !== region) ?? null
    const move = (moved: PointerEvent) => {
        if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < 6) {
            return
        }
        document.body.classList.add("tile-dragging")
        const next = tileAt(moved.clientX, moved.clientY)
        if (next !== target) {
            target?.classList.remove("drop-target")
            next?.classList.add("drop-target")
            target = next
        }
    }
    const up = () => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        removeEventListener("pointercancel", up)
        document.body.classList.remove("tile-dragging")
        target?.classList.remove("drop-target")
        const other = target?.dataset.region as Region | undefined
        if (other) {
            tiles.onOrder(swapTiles(tiles.order, region, other))
        }
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
    addEventListener("pointercancel", up)
}
