// Layout files (<name>.layout.json): the whole panel layout as GET api/layout gives it (the desktop and phone
// arrangements, the camera panels, the plots), saved from Settings and loaded from Settings or by dropping one anywhere
// on the page. A load is undone from its toast (the layout before it goes back through PUT api/layout).
import { toast } from "dimos-react"

export const LAYOUT_SUFFIX = ".layout.json"

/** what a layout file holds: the parts PUT api/layout takes (a part left out stays as it is) */
const PARTS = ["desktop", "phone", "cameras", "plots"] as const

type Layout = Partial<Record<(typeof PARTS)[number], unknown>>

async function call(method: "GET" | "PUT", body?: Layout): Promise<Layout> {
    const response = await fetch(new URL("api/layout", location.href).href, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(result.error ?? `${response.status}`)
    }
    return result
}

/** The layout parts of `value` (null ones dropped: PUT keeps a part that's null). */
export function layoutParts(value: unknown): Layout {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {}
    }
    const record = value as Record<string, unknown>
    return Object.fromEntries(PARTS.filter((part) => record[part] != null).map((part) => [part, record[part]]))
}

export function isLayoutFile(file: File): boolean {
    return file.name.toLowerCase().endsWith(LAYOUT_SUFFIX)
}

/** Downloads the current layout as `<name>.layout.json`. */
export async function saveLayoutFile(name = "controller") {
    try {
        const layout = layoutParts(await call("GET"))
        const link = document.createElement("a")
        link.href = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 4)], { type: "application/json" }))
        link.download = `${name}${LAYOUT_SUFFIX}`
        link.click()
        setTimeout(() => URL.revokeObjectURL(link.href), 0)
    } catch (error) {
        toast.error(`Couldn't save the layout: ${(error as Error).message}`)
    }
}

/** Applies a layout file to every open page, with Undo on its toast. */
export async function loadLayoutFile(file: File) {
    let layout: Layout
    try {
        layout = layoutParts(JSON.parse(await file.text()))
    } catch {
        toast.error(`${file.name} isn't a layout (not JSON)`)
        return
    }
    if (!Object.keys(layout).length) {
        toast.error(`${file.name} has no layout in it (desktop, phone, cameras or plots)`)
        return
    }
    try {
        const before = layoutParts(await call("GET"))
        await call("PUT", layout)
        toast.ok(`Layout loaded from ${file.name}`, {
            action: {
                label: "Undo",
                onClick: () => call("PUT", before).then(() => toast.ok("Layout change undone"), (error) => toast.error(`Couldn't undo the layout change: ${error.message}`)),
            },
        })
    } catch (error) {
        toast.error(`Couldn't load ${file.name}: ${(error as Error).message}`)
    }
}

/** Opens a file picker for a layout file and loads it. */
export function pickLayoutFile() {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = `${LAYOUT_SUFFIX},application/json`
    input.onchange = () => {
        const file = input.files?.[0]
        if (file) {
            loadLayoutFile(file)
        }
    }
    input.click()
}

/** A .layout.json dropped anywhere on the page is loaded (other files are left alone: a drop never navigates away). */
export function watchLayoutDrops(target: EventTarget = window): () => void {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false
    const over = (event: Event) => {
        if (hasFiles(event as DragEvent)) {
            event.preventDefault()
        }
    }
    const drop = (event: Event) => {
        const drag = event as DragEvent
        if (!hasFiles(drag)) {
            return
        }
        event.preventDefault()
        const files = [...(drag.dataTransfer?.files ?? [])]
        const layout = files.find(isLayoutFile)
        if (layout) {
            loadLayoutFile(layout)
        } else {
            toast.error(`Only a ${LAYOUT_SUFFIX} file can be dropped here`)
        }
    }
    target.addEventListener("dragover", over)
    target.addEventListener("drop", drop)
    return () => {
        target.removeEventListener("dragover", over)
        target.removeEventListener("drop", drop)
    }
}
