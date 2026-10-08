// Every panel's frame, the same everywhere: a header (its icon and title, a live note, then the same four buttons in
// the same place on every panel: fold, main view, pop out / dock, close), an optional row of the panel's own tools, and
// its body. The workspace (ui/Workspace.tsx) gives it its box; dragging the header moves it (rails, main view,
// floating; ui/workspace.ts snaps it), a double-click on the header folds it (on the main view: focus), and a floating
// panel resizes from its corner. Hidden (closed, a shut drawer) it stays mounted, so a video or the 3D view never restarts.
import { type ReactNode, useRef } from "react"
import { Icon } from "./icons.tsx"
import { panelActionStates, type PanelAction } from "./commands.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { arrange, clampFloat, FLOAT_MIN, movePanel, normalizeArrangement } from "./workspace.ts"
import { startPointerDrag } from "./panelDrag.ts"

const ACTION_ICONS: Record<PanelAction, (state: { collapsed: boolean; onStage: boolean; floating: boolean; focused: boolean }) => string> = {
    collapse: ({ collapsed }) => collapsed ? "chevron-down" : "chevron-up",
    main: ({ onStage, focused }) => onStage ? (focused ? "fullscreen-exit" : "fullscreen") : "expand",
    popout: ({ floating }) => floating ? "dock" : "float",
    close: () => "close",
}

export function Panel({ id, title, icon, info, tools, children, className = "", bodyClassName = "", testid, onBodyClick }: {
    id: string
    title: string
    icon: string
    /** a short live note in the header (resolution, rate, source) */
    info?: ReactNode
    /** the panel's own controls: a row under the header (not while folded) */
    tools?: ReactNode
    children?: ReactNode
    className?: string
    bodyClassName?: string
    testid?: string
    onBodyClick?: () => void
}) {
    const api = useWorkspaceApi()
    const element = useRef<HTMLDivElement>(null)
    const slot = api.layout.slots[id]
    if (!slot) {
        return null
    }
    const onStage = slot.zone === "stage"
    const floating = slot.zone === "float"
    const focused = onStage && api.view.hide.length === 2
    const states = panelActionStates(api.arrangement, id, { mobile: api.mobile, focused })
    const fromControl = (target: EventTarget) => !!(target as HTMLElement).closest("button, select, input, label, textarea, [role=tab]")
    const classes = ["lv-panel", `zone-${slot.zone}`, slot.collapsed ? "collapsed" : "", slot.hidden ? "hidden" : "", className]
    return (
        <section
            ref={element}
            className={classes.filter(Boolean).join(" ")}
            style={{ left: slot.rect.x, top: slot.rect.y, width: slot.rect.width, height: slot.rect.height }}
            data-panel={id}
            data-testid={testid}
            aria-hidden={slot.hidden || undefined}
            aria-label={title}
        >
            <header
                className="panel-head"
                onPointerDown={(event) => !fromControl(event.target) && element.current && api.startDrag(id, event, element.current)}
                onDoubleClick={(event) => !fromControl(event.target) && api.act(id, onStage ? "main" : "collapse")}
                title={api.mobile ? undefined : "Drag to move: into a rail, onto the main view's middle, or anywhere to float"}
            >
                <span className="panel-title"><Icon name={icon} size={14} /><span>{title}</span></span>
                {info !== undefined && <span className="panel-info">{info}</span>}
                <span className="panel-actions" role="toolbar" aria-label={`${title} panel`}>
                    {states.map((state) => (
                        <button
                            key={state.action}
                            type="button"
                            className={`dim-btn icon icon-button panel-action action-${state.action}`}
                            data-action={state.action}
                            disabled={state.disabled}
                            title={state.label}
                            aria-label={`${title}: ${state.label}`}
                            aria-pressed={state.action === "main" && onStage ? focused : undefined}
                            onClick={() => api.act(id, state.action)}
                        >
                            <Icon name={ACTION_ICONS[state.action]({ collapsed: slot.collapsed, onStage, floating, focused })} size={14} />
                        </button>
                    ))}
                </span>
            </header>
            {tools && !slot.collapsed && <div className="panel-tools">{tools}</div>}
            <div className={`panel-content ${bodyClassName}`} onClick={onBodyClick}>{children}</div>
            {floating && !slot.collapsed && !api.mobile && (
                <div
                    className="panel-resize"
                    title="Drag to resize"
                    aria-label="Resize"
                    onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        const start = slot.rect
                        startPointerDrag(event, (dx, dy) => {
                            const box = clampFloat({ ...start, width: Math.max(FLOAT_MIN.width, start.width + dx), height: Math.max(FLOAT_MIN.height, start.height + dy) }, api.layout.area)
                            arrange((current) => movePanel(normalizeArrangement(current, api.ids), id, { zone: "float", box: { ...box, x: start.x, y: start.y } }))
                        })
                    }}
                />
            )}
        </section>
    )
}

