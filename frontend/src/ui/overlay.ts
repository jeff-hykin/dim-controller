// The one overlay open over the page (the `/` palette or the `?` shortcut list), or none. While one is open the drive
// keys are off (Space still stops); Escape closes it.
import { Store } from "../core/store.ts"

export type OpenOverlay = "palette" | "help" | null

export const overlay = new Store<{ open: OpenOverlay }>({ open: null })

export const openOverlay = (open: OpenOverlay) => overlay.set({ open })
export const closeOverlay = () => overlay.set({ open: null })
