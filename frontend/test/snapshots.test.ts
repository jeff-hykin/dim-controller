// Snapshots (core/snapshots.ts, server/src/snapshots.rs): a picture goes to the backend as PNG bytes with its view and
// source in the query, the gallery follows the list each answer carries, and a download is named for what it shows.
import { assertEquals } from "jsr:@std/assert@1"
import { deleteSnapshot, downloadName, saveSnapshot, type Snapshot, snapshots, snapshotUrl } from "../src/core/snapshots.ts"

const color: Snapshot = { name: "1761400000000_camera_dimos-color-image.png", view: "camera", source: "dimos-color-image", created: Date.UTC(2026, 9, 25, 5, 32, 1), bytes: 10 }

Deno.test("downloads are named for the view or camera and the time", () => {
    assertEquals(downloadName(color), "dimos-color-image_2026-10-25T05-32-01.png")
    assertEquals(downloadName({ ...color, view: "3d", source: "" }), "3d-view_2026-10-25T05-32-01.png")
})

Deno.test("save posts the PNG with its view and source; the gallery takes the list from each answer", async () => {
    const realFetch = globalThis.fetch
    const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
    Object.defineProperty(globalThis, "location", { value: new URL("http://desktop/apps/dim-controller/"), configurable: true })
    const calls: { method: string; url: string; type: string | null; body: unknown }[] = []
    globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
        calls.push({ method: init.method ?? "GET", url: input, type: new Headers(init.headers).get("content-type"), body: init.body })
        const list = init.method === "DELETE" ? [] : [color]
        return new Response(JSON.stringify({ snapshot: color, snapshots: list }), { status: 200 })
    }) as typeof fetch
    try {
        const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })
        assertEquals(await saveSnapshot(png, "camera", "dimos/color_image/sensor_msgs.Image"), color)
        assertEquals(calls[0].method, "POST")
        assertEquals(calls[0].url, "http://desktop/apps/dim-controller/api/snapshots?view=camera&source=dimos%2Fcolor_image%2Fsensor_msgs.Image")
        assertEquals([calls[0].type, calls[0].body], ["image/png", png])
        assertEquals(snapshots.get().list, [color])
        await deleteSnapshot(color.name)
        assertEquals(calls[1].url, `http://desktop/apps/dim-controller/api/snapshots/${color.name}`)
        assertEquals(snapshots.get().list, [])
        assertEquals(snapshotUrl("a b.png"), "http://desktop/apps/dim-controller/api/snapshots/a%20b.png")
    } finally {
        globalThis.fetch = realFetch
        if (realLocation) {
            Object.defineProperty(globalThis, "location", realLocation)
        } else {
            delete (globalThis as { location?: unknown }).location
        }
    }
})
