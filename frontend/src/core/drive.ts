// Driving: keys, sticks and buttons push axes; while drive is ARMED and something is held, a Twist goes out at
// publishHz straight through the bridge. Nothing is published while disarmed or idle: a release sends a second of
// zeros so the stop is heard, then the topic goes quiet. While moving the bridge holds a zero Twist as a deadman
// and publishes it if this page goes silent for deadmanMs or disconnects (port of web_ctrl's drive loop).
// Arming is the backend's (POST api/drive/arm), one switch for every page and the agent; its `drive` events carry it
// back here, with the agent's commands (and dry runs) for the HUD.
import { encode } from "./lcm/lcm.ts"
import { persistentStore, Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { type Axes, type Axis, defaultTwist, type RobotProfile, type Twist } from "../profile/types.ts"

const TWIST = "geometry_msgs.Twist"
const ZERO = encode(TWIST, {})

export interface DriveSettings {
    linear: number
    angular: number
    vertical: number
    /** "" = the profile's pick from what's on the bridge */
    topic: string
}

export interface DriveState {
    armed: boolean
    axes: Axes
    boost: boolean
    /** what was last sent (or would be) */
    twist: Twist
    /** the topic actually used */
    topic: string
    publishing: boolean
    sent: number
    error: string | null
    /** who armed it (page, agent), from the backend */
    armedBy: string | null
    /** the last endpoint command (POST api/drive), shown until it ends */
    command: DriveCommand | null
}

/** What POST api/drive sent (or would have, for a dry run), as the backend describes it. */
export interface DriveCommand {
    key: string
    linear: [number, number, number]
    angular: [number, number, number]
    seconds: number
    dryRun: boolean
    source: string
}

/** The backend's `drive` event (server/src/api.rs). */
export interface DriveEvent {
    armed: boolean
    armedBy: string | null
    command: DriveCommand | null
}

const zeroAxes = (): Axes => ({ forward: 0, strafe: 0, turn: 0, vertical: 0 })

export class Drive {
    readonly state = new Store<DriveState>({ armed: false, axes: zeroAxes(), boost: false, twist: { linear: [0, 0, 0], angular: [0, 0, 0] }, topic: "", publishing: false, sent: 0, error: null, armedBy: null, command: null })
    readonly settings: Store<DriveSettings>
    readonly controlValues = new Store<Record<string, number>>({})
    /** axis contributions by source (keys, stick, pad), summed and clamped */
    #sources = new Map<string, Partial<Axes>>()
    #publisher: Publisher | null = null
    #publisherKey = ""
    #deadmanArmed = false
    #stopFlush = 0
    #timer: ReturnType<typeof setInterval>
    #commandTimer: ReturnType<typeof setTimeout> | undefined
    #controlPublishers = new Map<string, Publisher>()
    /** Twist topics the running blueprint reads (from Desktop's /dimos/ API) */
    #inputs: string[] = []
    /** Twist topics seen on the bridge (someone publishes them; maybe nobody reads them) */
    #onBridge: string[] = []

    constructor(readonly connection: Connection, readonly profile: RobotProfile) {
        const { speeds } = profile.drive
        this.settings = persistentStore(`lv.drive.${profile.name}`, { linear: speeds.linear, angular: speeds.angular, vertical: speeds.vertical, topic: "" })
        this.controlValues.set(Object.fromEntries(profile.controls.filter((control) => control.kind === "slider").map((control) => [control.id, control.kind === "slider" ? control.initial : 0])))
        this.#timer = setInterval(() => this.#tick(), 1000 / profile.drive.publishHz)
        this.settings.subscribe(() => this.#refreshTopic())
    }

    /** What the picker lists: the robot's Twist inputs, Twist topics on the bridge, the profile's. */
    setCandidates(inputs: string[], onBridge: string[] = []) {
        this.#inputs = inputs
        this.#onBridge = onBridge
        this.#refreshTopic()
    }

    candidates(): string[] {
        return [...new Set([...this.#inputs, ...this.#onBridge, ...this.profile.drive.cmdVelTopics])]
    }

    /**
     * The chosen topic, else from what the robot reads (if known), else from what's on the bridge: the profile's
     * first preference there, else one ending tele_cmd_vel, else cmd_vel. A topic only someone writes and nothing
     * reads would move nothing, so the robot's inputs come first.
     */
    #pickTopic(): string {
        const chosen = this.settings.get().topic
        if (chosen) {
            return chosen
        }
        const pick = (topics: string[]) => {
            const live = new Set(topics)
            return this.profile.drive.cmdVelTopics.find((topic) => live.has(topic))
                ?? topics.find((topic) => /tele_cmd_vel$/.test(topic))
                ?? topics.find((topic) => /cmd_vel$/.test(topic))
        }
        return pick(this.#inputs) ?? pick(this.#onBridge) ?? this.profile.drive.cmdVelTopics[0] ?? "/cmd_vel"
    }

    #refreshTopic() {
        const topic = this.#pickTopic()
        if (topic !== this.state.get().topic) {
            this.state.update({ topic })
        }
    }

    /** Arm or disarm for everyone: through the backend, applied here at once so a key right after works. */
    setArmed(armed: boolean) {
        this.#applyArmed(armed, armed ? "page" : null)
        if (typeof location === "undefined") {
            return // tests: no backend
        }
        fetch(new URL("api/drive/arm", location.href), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ armed, source: "page" }) })
            .then(async (response) => {
                if (!response.ok) {
                    this.state.update({ error: `arm: ${(await response.json().catch(() => ({}))).error ?? response.status}` })
                }
            })
            .catch(() => this.state.update({ error: "arm: the backend didn't answer" }))
    }

    /** The backend's `drive` event: arming (from any page or the agent) and the endpoint's commands. */
    applyEvent(event: DriveEvent) {
        this.#applyArmed(event.armed, event.armedBy)
        if (event.command) {
            clearTimeout(this.#commandTimer)
            this.state.update({ command: event.command })
            this.#commandTimer = setTimeout(() => this.state.update({ command: null }), Math.max(1500, event.command.seconds * 1000))
        } else if (this.state.get().command && !event.armed) {
            clearTimeout(this.#commandTimer)
            this.state.update({ command: null })
        }
    }

    #applyArmed(armed: boolean, armedBy: string | null) {
        if (!armed) {
            this.#sources.clear()
            this.#recompute()
            this.#deadmanArmed = false
            this.#publisher?.close()
            this.#publisher = null
            this.#publisherKey = ""
        }
        if (armed !== this.state.get().armed || armedBy !== this.state.get().armedBy) {
            this.state.update({ armed, armedBy, error: null })
        }
    }

    /** A source (e.g. "keys", "stick") sets its share of the axes; the sum (clamped to ±1) drives. */
    setAxes(source: string, axes: Partial<Axes>) {
        this.#sources.set(source, axes)
        this.#recompute()
    }

    setBoost(boost: boolean) {
        if (boost !== this.state.get().boost) {
            this.state.update({ boost })
            this.#recompute()
        }
    }

    /** Stop: every source released at once (space, the STOP button), and the agent's command too. */
    stop() {
        this.#sources.clear()
        this.#recompute()
        const command = this.state.get().command
        if (command && !command.dryRun && typeof location !== "undefined") {
            this.state.update({ command: null })
            fetch(new URL("api/drive/stop", location.href), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {})
        }
    }

    #recompute() {
        const axes = zeroAxes()
        for (const share of this.#sources.values()) {
            for (const axis of Object.keys(axes) as Axis[]) {
                axes[axis] += share[axis] ?? 0
            }
        }
        for (const axis of Object.keys(axes) as Axis[]) {
            axes[axis] = Math.max(-1, Math.min(1, axes[axis]))
        }
        const settings = this.settings.get()
        const { boost } = this.profile.drive
        const boosted = this.state.get().boost
        const speeds = {
            linear: settings.linear * (boosted ? boost.linear : 1),
            angular: settings.angular * (boosted ? boost.angular : 1),
            vertical: settings.vertical * (boosted ? boost.linear : 1),
        }
        const twist = (this.profile.drive.twist ?? defaultTwist)(axes, speeds)
        this.state.update({ axes, twist })
    }

    #publisherFor(key: string): Publisher | null {
        const client = this.connection.client
        if (!client || client.state === "lost") {
            return null
        }
        const usable = this.#publisher && !["tripped", "closed", "rejected"].includes(this.#publisher.state)
        if (usable && this.#publisherKey === key) {
            return this.#publisher
        }
        if (usable) {
            // the topic changed mid-drive: the old one gets its stop first
            if (this.#deadmanArmed) {
                this.#publisher!.put(ZERO)
            }
            this.#publisher!.close()
        }
        this.#publisher = client.publisher(key, { priority: Priority.REAL_TIME, latencyLimit: this.profile.drive.deadmanMs })
        this.#publisherKey = key
        this.#deadmanArmed = false
        return this.#publisher
    }

    #tick() {
        const state = this.state.get()
        if (!state.armed) {
            if (state.publishing) {
                this.state.update({ publishing: false })
            }
            return
        }
        const { twist } = state
        const moving = [...twist.linear, ...twist.angular].some((value) => value !== 0)
        if (moving) {
            this.#stopFlush = Math.round(this.profile.drive.publishHz)
        } else if (this.#stopFlush > 0) {
            this.#stopFlush--
        } else {
            if (this.#deadmanArmed) {
                this.#deadmanArmed = false
                this.#publisher?.clearDeadman().catch(() => {})
            }
            if (state.publishing) {
                this.state.update({ publishing: false })
            }
            return
        }
        const publisher = this.#publisherFor(dimosKey(state.topic, TWIST))
        if (!publisher) {
            this.state.update({ error: "not connected to the bridge" })
            return
        }
        try {
            if (moving && !this.#deadmanArmed) {
                this.#deadmanArmed = true
                publisher.setDeadman(ZERO).catch((error) => {
                    this.#deadmanArmed = false
                    this.state.update({ error: `deadman: ${error}` })
                })
            }
            publisher.put(encode(TWIST, { linear: xyz(twist.linear), angular: xyz(twist.angular) }))
            this.state.update({ publishing: true, sent: state.sent + 1, error: null })
        } catch (error) {
            // tripped since the last tick; the next one makes a fresh publisher
            this.#deadmanArmed = false
            this.state.update({ error: String(error) })
        }
    }

    /** Sets a profile slider (or steps it) and publishes its message, if armed. */
    setControl(id: string, value: number) {
        const control = this.profile.controls.find((other) => other.id === id)
        if (!control || control.kind !== "slider") {
            return
        }
        const clamped = Math.max(control.min, Math.min(control.max, Math.round(value / control.step) * control.step))
        this.controlValues.update({ [id]: clamped })
        this.#publishControl(control.id, control.topic, control.type, control.message(clamped))
    }

    stepControl(id: string, step: number) {
        this.setControl(id, (this.controlValues.get()[id] ?? 0) + step)
    }

    pressButton(id: string) {
        const control = this.profile.controls.find((other) => other.id === id)
        if (control?.kind === "button") {
            this.#publishControl(control.id, control.topic, control.type, control.message())
        }
    }

    // deno-lint-ignore no-explicit-any
    #publishControl(id: string, topic: string, type: string, message: any) {
        if (!this.state.get().armed) {
            this.state.update({ error: "arm drive to send commands" })
            return
        }
        const client = this.connection.client
        if (!client) {
            return
        }
        let publisher = this.#controlPublishers.get(id)
        if (!publisher || ["tripped", "closed", "rejected"].includes(publisher.state)) {
            publisher = client.publisher(dimosKey(topic, type), { priority: Priority.INTERACTIVE_HIGH, delivery: "reliable" })
            this.#controlPublishers.set(id, publisher)
        }
        publisher.put(encode(type, message))
    }

    dispose() {
        clearInterval(this.#timer)
        clearTimeout(this.#commandTimer)
        this.#publisher?.close()
        this.#controlPublishers.forEach((publisher) => publisher.close())
    }
}

const xyz = ([x, y, z]: [number, number, number]) => ({ x, y, z })
