// The Steam Deck banner's logic (ui/SteamDeckBanner.tsx). On a Steam Deck (or SteamOS) the Deck's controls only reach
// the page as a gamepad when dimOS was opened from Steam (Steam Input); Desktop >= 0.2.119 says where it runs
// (GET /api/steam-deck) and can open itself in Steam (POST /api/steam-deck/open). An older Desktop 404s: no banner.
// The shell marks a launch from Steam in sessionStorage["dimos.launch"] = "steam" (from ?launch=steam).

/** GET /api/steam-deck (Desktop >= 0.2.119); the fields this reads */
export interface SteamDeckInfo {
    steamDeck: boolean
    steamOs: boolean
    steamShortcut?: boolean
    gameId?: string
    runGameUrl?: string
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Desktop's answer, or null: not under Desktop, an older Desktop (404), or anything unreadable. Never throws. */
export async function fetchSteamDeck(fetcher: Fetch, origin: string): Promise<SteamDeckInfo | null> {
    try {
        const response = await fetcher(new URL("/api/steam-deck", origin).href)
        if (!response.ok) {
            return null
        }
        const body = await response.json()
        return body && typeof body === "object" ? { ...body, steamDeck: body.steamDeck === true, steamOs: body.steamOs === true } : null
    } catch {
        return null
    }
}

/** Shown on a Deck (or SteamOS) when dimOS wasn't opened from Steam and no gamepad is reaching the page, until dismissed. */
export function shouldShowSteamBanner(state: { info: SteamDeckInfo | null; launch: string | null; gamepadConnected: boolean; dismissed: boolean }): boolean {
    return !!state.info && (state.info.steamDeck || state.info.steamOs) && state.launch !== "steam" && !state.gamepadConnected && !state.dismissed
}

/** POST /api/steam-deck/open: what Desktop did ("started", "launched", "restarted", "needs-restart") and its message. */
export async function openInSteam(fetcher: Fetch, origin: string): Promise<{ ok: boolean; did: string; message: string }> {
    try {
        const response = await fetcher(new URL("/api/steam-deck/open", origin).href, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
        const body = await response.json().catch(() => ({}))
        const message = typeof body?.message === "string" ? body.message : typeof body?.reason === "string" ? body.reason : typeof body?.error === "string" ? body.error : ""
        if (!response.ok) {
            return { ok: false, did: "", message: message || `Desktop couldn't open dimOS in Steam (${response.status}).` }
        }
        return { ok: true, did: typeof body?.did === "string" ? body.did : "", message: message || "Opening dimOS in Steam…" }
    } catch (error) {
        return { ok: false, did: "", message: `Desktop couldn't be reached (${(error as Error)?.message ?? error}).` }
    }
}

export const DISMISS_KEY = "lv.steamDeckBanner.dismissed"
export const LAUNCH_KEY = "dimos.launch"
