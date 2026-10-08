// The Steam Deck banner (core/steamDeck.ts) against a mocked Desktop API: shown on a Deck / SteamOS opened outside
// Steam with no gamepad, hidden on an older Desktop (404) or anything unreadable, and the open call's outcomes.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { fetchSteamDeck, openInSteam, shouldShowSteamBanner, type SteamDeckInfo } from "../src/core/steamDeck.ts"

const ORIGIN = "http://127.0.0.1:5555"
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const deck: SteamDeckInfo = { steamDeck: true, steamOs: true, steamShortcut: true, gameId: "1234", runGameUrl: "steam://rungameid/1234" }

Deno.test("Desktop >= 0.2.119 answers; an older one 404s, an unreachable or odd one is no banner, never an error", async () => {
    const asked: string[] = []
    const answer = await fetchSteamDeck((url) => (asked.push(url), Promise.resolve(json(200, deck))), ORIGIN)
    assertEquals(asked, [`${ORIGIN}/api/steam-deck`])
    assertEquals(answer?.runGameUrl, "steam://rungameid/1234")
    assertEquals(await fetchSteamDeck(() => Promise.resolve(new Response("not found", { status: 404 })), ORIGIN), null)
    assertEquals(await fetchSteamDeck(() => Promise.reject(new TypeError("offline")), ORIGIN), null)
    assertEquals(await fetchSteamDeck(() => Promise.resolve(new Response("<html>", { status: 200 })), ORIGIN), null)
    // fields that aren't booleans read as false
    assertEquals((await fetchSteamDeck(() => Promise.resolve(json(200, { steamDeck: "yes" })), ORIGIN))?.steamDeck, false)
})

Deno.test("shown on a Deck or SteamOS opened outside Steam with no gamepad, until dismissed", () => {
    const base = { info: deck, launch: null, gamepadConnected: false, dismissed: false }
    assert(shouldShowSteamBanner(base))
    assert(shouldShowSteamBanner({ ...base, info: { steamDeck: false, steamOs: true } }))
    assert(!shouldShowSteamBanner({ ...base, info: { steamDeck: false, steamOs: false } }), "not a Deck")
    assert(!shouldShowSteamBanner({ ...base, info: null }), "an older Desktop (404)")
    assert(!shouldShowSteamBanner({ ...base, launch: "steam" }), "opened from Steam")
    assert(!shouldShowSteamBanner({ ...base, gamepadConnected: true }), "the controls already reach the page")
    assert(!shouldShowSteamBanner({ ...base, dismissed: true }))
})

Deno.test("Open dimOS in Steam: POSTs once, says what Desktop did, a 409's reason or an unreachable Desktop", async () => {
    const calls: { url: string; method?: string }[] = []
    const ok = await openInSteam((url, init) => (calls.push({ url, method: init?.method }), Promise.resolve(json(200, { did: "launched", message: "dimOS is opening in Steam" }))), ORIGIN)
    assertEquals(calls, [{ url: `${ORIGIN}/api/steam-deck/open`, method: "POST" }])
    assertEquals(ok, { ok: true, did: "launched", message: "dimOS is opening in Steam" })
    const restart = await openInSteam(() => Promise.resolve(json(200, { did: "needs-restart", message: "Restart Steam to finish" })), ORIGIN)
    assertEquals([restart.ok, restart.did], [true, "needs-restart"])
    const refused = await openInSteam(() => Promise.resolve(json(409, { reason: "Steam isn't running" })), ORIGIN)
    assertEquals(refused, { ok: false, did: "", message: "Steam isn't running" })
    const bare = await openInSteam(() => Promise.resolve(new Response("", { status: 409 })), ORIGIN)
    assert(!bare.ok && /409/.test(bare.message))
    const gone = await openInSteam(() => Promise.reject(new TypeError("offline")), ORIGIN)
    assert(!gone.ok && /reached/.test(gone.message))
})
