// Every action on the page as a command, so the `/` palette reaches all of them: driving (STOP, Reconnect, boost), each
// panel's own four actions (the same four its header has), the layout, the view, recording, settings and the robot
// profile's buttons. The filter (multi-word, every word must match) and the per-panel commands are pure and unit tested
// (test/commands.test.ts).
import { type Arrangement, isCamera, locate } from "./workspace.ts"

export type CommandGroup = "Drive" | "Panels" | "Layout" | "View" | "Cameras" | "Record" | "Robot" | "Settings" | "Help"

export interface Command {
    id: string
    label: string
    group: CommandGroup
    /** shortcut keys to show beside it */
    keys?: string[]
    /** a short tag: where it goes, what it changes */
    hint?: string
    /** red: it stops or moves the robot */
    danger?: boolean
    /** why it can't run now (shown, and it doesn't run) */
    blocked?: string
    /** extra words it's found by */
    words?: string
    run: () => void
}

/** Commands matching `query`: every word in the label, group, hint, keys or extra words; the order kept (empty: all). */
export function filterCommands(commands: Command[], query: string): Command[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) {
        return commands
    }
    return commands.filter((command) => {
        const text = [command.label, command.group, command.hint ?? "", (command.keys ?? []).join(" "), command.words ?? ""].join(" ").toLowerCase()
        return words.every((word) => text.includes(word))
    })
}

/** The four actions every panel header has, in the same order, as the header's buttons name them. */
export type PanelAction = "collapse" | "main" | "popout" | "close"

export interface PanelActionState {
    action: PanelAction
    label: string
    /** a button that can't act here (a stage panel can't fold; a phone can't float) */
    disabled: boolean
}

/** What each of a panel's four buttons does where the panel is now (the header and the palette share this). */
export function panelActionStates(arrangement: Arrangement, id: string, options: { mobile: boolean; focused: boolean }): PanelActionState[] {
    const zone = locate(arrangement, id)?.zone ?? "closed"
    const onStage = zone === "stage"
    const collapsed = arrangement.collapsed.includes(id)
    return [
        { action: "collapse", label: onStage ? "Fold (not in the main view)" : collapsed ? "Unfold" : "Fold to its header", disabled: onStage || zone === "closed" },
        { action: "main", label: onStage ? (options.focused ? "Show the side rails again" : "Focus: hide the side rails") : "Show in the main view (swap)", disabled: false },
        { action: "popout", label: zone === "float" ? "Dock into the nearest rail" : "Pop out: float over the main view", disabled: options.mobile || zone === "closed" },
        { action: "close", label: zone === "closed" ? "Closed (open it from the palette)" : "Close (reopen from the palette)", disabled: zone === "closed" },
    ]
}

/** The palette's commands for one panel: open it, then each of its header's actions that applies where it is. */
export function panelCommands(arrangement: Arrangement, id: string, title: string, options: { mobile: boolean; focused: boolean }, act: (action: PanelAction | "show") => void): Command[] {
    const zone = locate(arrangement, id)?.zone ?? "closed"
    const commands: Command[] = [{
        id: `panel.${id}.show`,
        label: `${title}: show`,
        group: "Panels",
        hint: zone === "closed" ? "closed" : zone === "stage" ? "main view" : zone === "float" ? "floating" : `${zone} rail`,
        words: "open reveal panel",
        run: () => act("show"),
    }]
    for (const state of panelActionStates(arrangement, id, options)) {
        if (!state.disabled) {
            commands.push({ id: `panel.${id}.${state.action}`, label: `${title}: ${state.label}`, group: "Panels", words: `panel ${state.action} maximize float dock collapse`, run: () => act(state.action) })
        }
    }
    return commands
}

/** what each panel is called (a header's title, a palette entry) */
export function panelTitle(id: string): string {
    if (isCamera(id)) {
        const n = Number(id.split(":")[1])
        return n > 1 ? `Camera ${n}` : "Camera"
    }
    return ({ map: "Map", scene: "3D view", status: "Status", settings: "Settings", layers: "Layers", tf: "Transforms (TF)" } as Record<string, string>)[id] ?? id
}
