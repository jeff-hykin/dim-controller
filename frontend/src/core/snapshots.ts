// Snapshots (server/src/snapshots.rs): the 3D view's and each camera panel's snapshot button saves the picture as a PNG on
// the backend, so every open page's gallery (ui/SnapshotGallery.tsx) shows the same ones; it follows the backend's
// `snapshots` events (core/agent.ts).
import { Store } from "./store.ts"

export interface Snapshot {
    /** its file name on the backend */
    name: string
    /** "3d" or "camera" */
    view: string
    /** the camera topic it came from, punctuation as "-" ("" for the 3D view) */
    source: string
    /** unix ms */
    created: number
    bytes: number
}

export const snapshots = new Store<{ list: Snapshot[]; galleryOpen: boolean }>({ list: [], galleryOpen: false })

const url = (path: string) => new URL(path, location.href).href

/** the picture's URL (a PNG) */
export const snapshotUrl = (name: string) => url(`api/snapshots/${encodeURIComponent(name)}`)

async function call(method: string, path: string, body?: Blob) {
    const response = await fetch(url(path), { method, headers: body ? { "content-type": "image/png" } : undefined, body })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(result.error ?? `${response.status}`)
    }
    return result
}

export async function loadSnapshots() {
    const { snapshots: list } = await call("GET", "api/snapshots")
    snapshots.update({ list: list ?? [] })
}

/** Saves a PNG; returns the saved snapshot. */
export async function saveSnapshot(png: Blob, view: "3d" | "camera", source = ""): Promise<Snapshot> {
    const { snapshot, snapshots: list } = await call("POST", `api/snapshots?${new URLSearchParams({ view, source })}`, png)
    snapshots.update({ list })
    return snapshot
}

export async function deleteSnapshot(name: string) {
    const { snapshots: list } = await call("DELETE", `api/snapshots/${encodeURIComponent(name)}`)
    snapshots.update({ list })
}

/** The pictures drawn over each other, in order, each stretched to `width` × `height` (a camera's picture, then its
 * overlay), over `background` if given (the 3D view's canvas is transparent: its backdrop is the page's). */
export function composeSnapshot(layers: CanvasImageSource[], width: number, height: number, background?: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")!
    if (background) {
        context.fillStyle = background
        context.fillRect(0, 0, width, height)
    }
    for (const layer of layers) {
        context.drawImage(layer, 0, 0, width, height)
    }
    return canvas
}

/** The 3D view as it looks now, over the scene's backdrop color, as a PNG. */
export async function snapshot3d(capture: () => string): Promise<Blob> {
    const picture = new Image()
    picture.src = capture()
    await picture.decode()
    const style = getComputedStyle(document.body)
    const background = style.getPropertyValue("--scene-bg").trim() || style.getPropertyValue("--bg").trim()
    return canvasToPng(composeSnapshot([picture], picture.naturalWidth, picture.naturalHeight, background))
}

export const canvasToPng = (canvas: HTMLCanvasElement): Promise<Blob> =>
    new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the picture couldn't be encoded"))), "image/png"))

/** A file name for downloading a snapshot: the view or camera and when it was taken. */
export function downloadName(snapshot: Snapshot): string {
    const when = new Date(snapshot.created).toISOString().replace(/\.\d+Z$/, "").replaceAll(":", "-")
    return `${snapshot.view === "3d" ? "3d-view" : snapshot.source || "camera"}_${when}.png`
}
