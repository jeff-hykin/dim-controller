// Client for this app's own backend recorder (server/src/recorder.rs), at ./api/recorder.
import { Store } from "./store.ts"

export interface RecordingStatus {
    active: boolean
    path: string | null
    messages: number
    bytes: number
    dropped: number
    seconds: number
}

export interface RecordingFile {
    name: string
    path: string
    bytes: number
    seconds_old: number
    /** Desktop's id for it in the shared recordings folder (GET /recordings); absent when listed by this backend */
    id?: string
}

export interface RecorderStatus {
    recording: RecordingStatus
    keys: string[]
    /** dimos log dirs being tailed into the recording, and the lines written so far */
    logs: { dirs: string[]; lines: number }
    files: RecordingFile[]
    settings: { compression: "none" | "lz4" | "zstd"; image_format: "raw" | "jpeg" | "png" | "webp" | "jpegxl" }
    directory: string
    /** null = the backend answered; else why it didn't */
    unavailable: string | null
}

const base = () => new URL("api/recorder", location.href).href
// Desktop's shared recordings folder API (docs/api.md in dimos-desktop); the page lives at /apps/<name>/
const desktopRecordings = () => new URL("../../recordings", location.href).href

interface DesktopRecording {
    id: string
    name: string
    path: string
    size: number
    modified: number
}

/** Every recording in Desktop's shared folder, or null when this page isn't running inside Desktop. */
async function sharedRecordings(): Promise<RecordingFile[] | null> {
    try {
        const response = await fetch(desktopRecordings())
        if (!response.ok) {
            return null
        }
        const body = (await response.json()) as { recordings: DesktopRecording[] }
        const now = Date.now() / 1000
        return body.recordings.map((recording) => ({
            id: recording.id,
            name: recording.id,
            path: recording.path,
            bytes: recording.size,
            seconds_old: Math.max(0, now - recording.modified),
        }))
    } catch {
        return null
    }
}

async function call(path: string, init?: RequestInit) {
    const response = await fetch(base() + path, { headers: { "content-type": "application/json" }, ...init })
    if (response.status === 204) {
        return null
    }
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(body.error ?? `${response.status}`)
    }
    return body
}

class RecorderClient {
    readonly status = new Store<RecorderStatus>({
        recording: { active: false, path: null, messages: 0, bytes: 0, dropped: 0, seconds: 0 },
        keys: [],
        logs: { dirs: [], lines: 0 },
        files: [],
        settings: { compression: "none", image_format: "raw" },
        directory: "",
        unavailable: "connecting…",
    })
    #watchers = 0

    constructor() {
        this.#poll()
    }

    async refresh() {
        try {
            const [status, shared] = await Promise.all([call(""), sharedRecordings()])
            // the file list is Desktop's shared folder when there is one (it's where this recorder writes)
            this.status.set({ ...status, files: shared ?? status.files, unavailable: null })
        } catch (error) {
            this.status.update({ unavailable: `recorder backend unreachable (${error})` })
        }
    }

    async #poll() {
        for (;;) {
            await this.refresh()
            const fast = this.status.get().recording.active || this.#watchers > 0
            await new Promise((resolve) => setTimeout(resolve, fast ? 1000 : 5000))
        }
    }

    /** A panel showing live numbers asks for 1 s updates while it's open. */
    watch(): () => void {
        this.#watchers++
        return () => this.#watchers--
    }

    /**
     * Starts recording `keys`, or (null) every topic on the bus except rpc ones and the ones unticked in the panel,
     * with new topics joining: the backend picks them, and the running dimos's logs (server/src/recorder.rs).
     */
    async start(keys: string[] | null) {
        await call("/start", { method: "POST", body: JSON.stringify(keys ? { keys } : {}) })
        await this.refresh()
    }

    async stop() {
        await call("/stop", { method: "POST" })
        await this.refresh()
    }

    async settings(patch: Partial<RecorderStatus["settings"]> & { directory?: string }) {
        this.status.set({ ...(await call("/settings", { method: "PUT", body: JSON.stringify(patch) })), unavailable: null })
    }

    async remove(file: RecordingFile) {
        if (file.id) {
            const response = await fetch(`${desktopRecordings()}/${file.id.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" })
            if (!response.ok) {
                throw new Error((await response.json().catch(() => ({}))).error ?? `${response.status}`)
            }
        } else {
            await call(`/files/${encodeURIComponent(file.name)}`, { method: "DELETE" })
        }
        await this.refresh()
    }

    downloadUrl(file: RecordingFile) {
        if (file.id) {
            return `${desktopRecordings()}/${file.id.split("/").map(encodeURIComponent).join("/")}/file`
        }
        return `${base()}/files/${encodeURIComponent(file.name)}`
    }
}

export const recorder = new RecorderClient()
