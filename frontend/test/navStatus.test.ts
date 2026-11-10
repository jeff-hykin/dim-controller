// The bar's nav chip: what the planner says about the goal, and in particular that it says anything at all when it
// cannot plan one (ui/barStatus.ts navChip, core/navStatusFeed.ts).
import { assertEquals } from "jsr:@std/assert@1"
import { navChip } from "../src/ui/barStatus.ts"
import {
    ABORTED,
    ACTIVE,
    NAV_DONE_MS,
    NAV_STALE_MS,
    navStatusOf,
    PENDING,
    REJECTED,
    SUCCEEDED,
} from "../src/core/navStatusFeed.ts"

const NOW = 1_000_000

const at = (status: number, text = "", age = 0) =>
    navStatusOf("/nav_status", { status, text }, NOW - age)

Deno.test("no status, nothing to say", () => {
    assertEquals(navChip(null, NOW), null)
})

Deno.test("driving to the goal", () => {
    const chip = navChip(at(ACTIVE), NOW)
    assertEquals(chip?.text, "navigating")
    assertEquals(chip?.tone, "ok")
})

Deno.test("a goal it cannot plan says so, with the planner's reason", () => {
    const chip = navChip(at(ABORTED, "no full path to goal"), NOW)
    assertEquals(chip?.text, "no route")
    assertEquals(chip?.tone, "bad")
    assertEquals(chip?.detail.includes("no full path to goal"), true)
})

Deno.test("a refused goal is its own tone", () => {
    assertEquals(navChip(at(REJECTED), NOW)?.text, "goal refused")
    assertEquals(navChip(at(PENDING), NOW)?.tone, "warn")
})

Deno.test("arriving shows briefly, then the chip goes", () => {
    assertEquals(navChip(at(SUCCEEDED, "", 1000), NOW)?.text, "arrived")
    assertEquals(navChip(at(SUCCEEDED, "", NAV_DONE_MS + 1), NOW), null)
})

Deno.test("a problem stays until the status stops coming", () => {
    assertEquals(
        navChip(at(ABORTED, "", NAV_DONE_MS + 1), NOW)?.text,
        "no route",
    )
    assertEquals(navChip(at(ABORTED, "", NAV_STALE_MS + 1), NOW), null)
})

Deno.test("an unknown status is not silence", () => {
    assertEquals(navChip(at(42), NOW)?.text, "goal lost")
})

Deno.test("a message with no status at all reads as lost, not as active", () => {
    const status = navStatusOf("/nav_status", {}, NOW)
    assertEquals(navChip(status, NOW)?.text, "goal lost")
})
