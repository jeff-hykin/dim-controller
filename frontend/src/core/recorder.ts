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
}

export interface RecorderStatus {
    recording: RecordingStatus
    keys: string[]
    files: RecordingFile[]
    settings: { compression: "none" | "lz4" | "zstd"; image_format: "raw" | "jpeg" | "png" | "webp" | "jpegxl" }
    directory: string
    /** null = the backend answered; else why it didn't */
    unavailable: string | null
}

const base = () => new URL("api/recorder", location.href).href

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
            this.status.set({ ...(await call("")), unavailable: null })
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

    async start(keys: string[]) {
        await call("/start", { method: "POST", body: JSON.stringify({ keys }) })
        await this.refresh()
    }

    async add(keys: string[]) {
        await call("/add", { method: "POST", body: JSON.stringify({ keys }) })
    }

    async stop() {
        await call("/stop", { method: "POST" })
        await this.refresh()
    }

    async settings(patch: Partial<RecorderStatus["settings"]> & { directory?: string }) {
        this.status.set({ ...(await call("/settings", { method: "PUT", body: JSON.stringify(patch) })), unavailable: null })
    }

    async remove(name: string) {
        await call(`/files/${encodeURIComponent(name)}`, { method: "DELETE" })
        await this.refresh()
    }

    downloadUrl(name: string) {
        return `${base()}/files/${encodeURIComponent(name)}`
    }
}

export const recorder = new RecorderClient()
