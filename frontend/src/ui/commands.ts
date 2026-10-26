// Every action on the page as a command, so the `/` palette reaches all of them: driving (STOP, Reconnect, boost), each
// panel's own actions (the ones its header has), the layout, the view, recording, settings and the robot
// profile's buttons. The filter (multi-word, every word must match) and the per-panel commands are pure and unit tested
// (test/commands.test.ts).
import { type Arrangement, isCamera, isPlot, locate } from "./workspace.ts"

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

/**
 * A panel's header actions: fold / unfold (folded, a panel with a stream of its own unsubscribes), make it the main view
 * (swap: the main view's panel takes its place), and pop out / dock. No close: a panel folds instead.
 */
export type PanelAction = "collapse" | "main" | "minimize" | "popout"

export interface PanelActionState {
    action: PanelAction
    label: string
}

/** The header buttons a panel has where it is now, in their fixed order (the header and the palette share this). */
export function panelActions(arrangement: Arrangement, id: string, options: { mobile: boolean }): PanelActionState[] {
    const zone = locate(arrangement, id)?.zone
    if (!zone) {
        return []
    }
    const states: PanelActionState[] = []
    // no make-main, minimize or collapse buttons (Jeff 10-26): a click on the header folds it; the main view is
    // picked by dragging a header onto it or from the settings drawer (the palette has both)
    // a phone floats panels from the panel list, so its only pop-out button is the floating panel's close
    if (!options.mobile) {
        states.push({ action: "popout", label: zone === "float" ? "Dock into the nearest rail" : "Pop out: float over the main view" })
    } else if (zone === "float") {
        states.push({ action: "popout", label: "Close" })
    }
    return states
}

/** The palette's commands for one panel: show it, then each of its header's actions. */
export function panelCommands(arrangement: Arrangement, id: string, title: string, options: { mobile: boolean }, act: (action: PanelAction | "show") => void): Command[] {
    const zone = locate(arrangement, id)?.zone
    const commands: Command[] = [{
        id: `panel.${id}.show`,
        label: `${title}: show`,
        group: "Panels",
        hint: zone === "stage" ? "main view" : zone === "float" ? "floating" : `${zone} rail`,
        words: "open reveal expand panel",
        run: () => act("show"),
    }]
    for (const state of panelActions(arrangement, id, options)) {
        commands.push({ id: `panel.${id}.${state.action}`, label: `${title}: ${state.label}`, group: "Panels", words: `panel ${state.action} maximize minimize main float dock collapse fold`, run: () => act(state.action) })
    }
    // no header buttons for these any more, but the palette still folds a panel and makes it the main view
    if (zone && zone !== "stage") {
        commands.push({ id: `panel.${id}.collapse`, label: `${title}: ${arrangement.collapsed.includes(id) ? "expand" : "collapse (stops its stream)"}`, group: "Panels", words: "panel fold collapse expand", run: () => act("collapse") })
        commands.push({ id: `panel.${id}.main`, label: `${title}: make it the main view`, group: "Panels", words: "panel maximize main swap", run: () => act("main") })
    }
    return commands
}

/** what each panel is called (a header's title, a palette entry) */
export function panelTitle(id: string): string {
    if (isCamera(id)) {
        const n = Number(id.split(":")[1])
        return n > 1 ? `Camera ${n}` : "Camera"
    }
    if (isPlot(id)) {
        return `Plot ${id.split(":")[1]}`
    }
    return ({ map: "Map", scene: "3D view", status: "Status", settings: "Settings", arms: "Arms", tf: "Transforms (TF)" } as Record<string, string>)[id] ?? id
}
