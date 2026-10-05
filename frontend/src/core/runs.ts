// What's running, for the first-run messages and the drive topic: Desktop's GET /dimos/runs (+ each running
// blueprint's Twist inputs), refreshed live on Desktop's zenoh `runs` and the dimos server's `launch` events, and again
// after the zenoh-web connection comes back (docs/events.md: snapshot + live). GET /dimos/info says if dimOS is there.
import { getZenoh } from "../dim-app/zenoh.js"
import { Store } from "./store.ts"

export interface RunState {
    /** false until the first answer (or when there's no Desktop dimos API here: dev server, remote robot) */
    known: boolean
    /** Desktop's /dimos API answered */
    desktop: boolean
    /** null = unknown */
    dimosInstalled: boolean | null
    /** blueprints running now */
    running: string[]
    /** a blueprint the Launcher is starting, or null */
    starting: string | null
    /** Twist topics the running blueprints take as input, e.g. /cmd_vel */
    driveInputs: string[]
}

type Runs = { launch?: { blueprint?: string; phase?: string } | null; runs?: { blueprint: string }[] }
type Blueprint = { modules?: { streams?: { name: string; type?: string; direction?: string }[] }[] }

const desktopUrl = (path: string) => new URL(`../../${path}`, location.href)

export class RunWatch {
    readonly state = new Store<RunState>({ known: false, desktop: false, dimosInstalled: null, running: [], starting: null, driveInputs: [] })
    #pending: Promise<void> | null = null
    #again = false
    #blueprints = new Map<string, string[]>()

    start() {
        const zenoh = getZenoh()
        zenoh.subscribeDesktop("runs", () => this.refresh())
        zenoh.subscribeDimos("launch", () => this.refresh())
        zenoh.onReconnect(() => this.refresh())
        this.refresh()
        // a slow safety net only: the events above are what make it live
        setInterval(() => this.refresh(), 30_000)
    }

    /** Re-GETs (coalesced: a call while one is in flight runs once more after it). */
    refresh(): Promise<void> {
        if (this.#pending) {
            this.#again = true
            return this.#pending
        }
        this.#pending = this.#load().finally(() => {
            this.#pending = null
            if (this.#again) {
                this.#again = false
                this.refresh()
            }
        })
        return this.#pending
    }

    async #inputsOf(name: string): Promise<string[]> {
        const cached = this.#blueprints.get(name)
        if (cached) {
            return cached
        }
        const blueprint: Blueprint = await (await fetch(desktopUrl(`dimos/blueprints/${encodeURIComponent(name)}`))).json()
        const inputs: string[] = []
        for (const module of blueprint.modules ?? []) {
            for (const stream of module.streams ?? []) {
                if (/Twist$/.test(stream.type ?? "") && stream.direction !== "out") {
                    inputs.push("/" + String(stream.name).replace(/^\/+/, ""))
                }
            }
        }
        this.#blueprints.set(name, inputs)
        return inputs
    }

    async #load() {
        let dimosInstalled = this.state.get().dimosInstalled
        try {
            const info = await (await fetch(desktopUrl("dimos/info"))).json()
            dimosInstalled = !!(info.found && info.installed)
        } catch {
            // no Desktop here: keep what we knew
        }
        try {
            const response = await fetch(desktopUrl("dimos/runs"))
            if (!response.ok) {
                throw new Error(String(response.status))
            }
            const runs: Runs = await response.json()
            const phase = runs.launch?.phase
            const running = new Set<string>((runs.runs ?? []).map((run) => run.blueprint).filter(Boolean))
            if (phase === "running" && runs.launch?.blueprint) {
                running.add(runs.launch.blueprint)
            }
            const starting = phase === "starting" ? runs.launch?.blueprint ?? null : null
            const inputs: string[] = []
            for (const name of running) {
                try {
                    inputs.push(...await this.#inputsOf(name))
                } catch {
                    // its metadata isn't available: the bridge's Twist topics still count
                }
            }
            this.state.set({ known: true, desktop: true, dimosInstalled, running: [...running], starting, driveInputs: [...new Set(inputs)] })
        } catch {
            // no Desktop dimos API here (dev server, remote robot): the profile's list and the bridge are enough
            this.state.update({ known: true, desktop: false, dimosInstalled })
        }
    }
}
