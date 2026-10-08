// The action dock's buttons follow the main view: each panel offers its own actions (a camera: fit / fill, next camera,
// quality; the 3D view: follow; the map: follow, fit), and the dock shows the ones of whichever panel is the main view.
// A panel offers them with useDockActions while it's mounted, so they always run the panel's current state.
import { useEffect, useRef } from "react"
import { Store } from "../core/store.ts"

export interface DockAction {
    id: string
    label: string
    icon: string
    title: string
    /** a toggle that's on now */
    pressed?: boolean
    run: () => void
}

/** panel id → the actions it offers the dock */
export const dockActions = new Store<Record<string, DockAction[]>>({})

/** The dock's panel actions with `stage` the main view (none: nothing in it, or a panel without any). */
export function dockActionsFor(offered: Record<string, DockAction[]>, stage: string | null): DockAction[] {
    return stage ? offered[stage] ?? [] : []
}

/** `panel` offers `actions` to the dock while it's mounted (each runs the latest render's handler). */
export function useDockActions(panel: string, actions: DockAction[]) {
    const latest = useRef(actions)
    latest.current = actions
    const shape = actions.map((action) => `${action.id}\u0000${action.label}\u0000${action.icon}\u0000${action.title}\u0000${action.pressed}`).join("\u0001")
    useEffect(() => {
        const offered = actions.map((action) => ({ ...action, run: () => latest.current.find((other) => other.id === action.id)?.run() }))
        dockActions.set({ ...dockActions.get(), [panel]: offered })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel, shape])
    useEffect(() => () => {
        const { [panel]: _gone, ...rest } = dockActions.get()
        dockActions.set(rest)
    }, [panel])
}
