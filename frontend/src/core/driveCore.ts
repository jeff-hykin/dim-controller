// What driving needs and nothing 3D (no three.js): the gateway connection, the drive and gamepad publishers, the arm's
// jog, the robot type, what runs, the link watch and Reconnect. main.tsx makes it before the rest of the page has loaded,
// so the keys drive while the 3D view and the panels (core/app.ts, its own chunk) are still on their way; ViewerApp
// then takes this same one over.
import { Connection, dimosKey } from "./transport.ts"
import { zenohKey } from "./cmdvel.ts"
import { feedBattery } from "./batteryFeed.ts"
import { Drive } from "./drive.ts"
import { JOY_TYPE, JoyPublisher, joySettings, joyTopic } from "./joy.ts"
import { ArmControl } from "./arm.ts"
import { RunWatch } from "./runs.ts"
import { persistentStore, Store } from "./store.ts"
import { profileFor } from "../profile/index.ts"
import type { RobotProfile, RobotType } from "../profile/types.ts"
import { checkLink, DEFAULT_MAX_LATENCY_MS, LINK_CHECK_MS, maxLatencyOf } from "./linkWatch.ts"
import type { ResolvedType, RobotsAnswer } from "./robotType.ts"
import { robotsAnswer } from "./robotType.ts"

export interface ViewSettings {
    /** the robot type picked in Settings (a RobotType), "" = auto (core/robotType.ts) */
    profile: string
    /** the type in use (auto's answer, or the pick), written by the page for the backend and the agent */
    robot?: string
    /** "" = the profile's, else picked from the tree */
    fixedFrame: string
    follow: boolean
    /** the TF frame the 3D camera follows: "" = base_link when it's in TF, else the profile's base frame */
    followFrame: string
    /** following, the camera turns with the followed frame's heading (yaw only: the world stays level) */
    followTurns: boolean
    showStats: boolean
    /** the robot type's stand-in model at the robot's pose */
    robotModel: boolean
    /** driving holds (Reconnect on the drive panel) once the control link's latency goes over this (ms) */
    maxLatencyMs: number
    /** every camera drawn in the 3D view (its picture and frustum at its CameraInfo frame; layers/camera3d.tsx) */
    camerasIn3d: boolean
    /** the CAD view cube in the 3D view's top-right corner (click a face to look from there) */
    viewCube: boolean
    /** how long a hidden tab keeps its cameras subscribed (s; unset: 60) */
    cameraHiddenGraceS?: number
    /** a camera with no new picture for this long says "slow / stopped link" (s; unset: 1) */
    cameraStallS?: number
    /** a camera with no new picture for this long subscribes afresh, then less and less often (s; unset: 3) */
    cameraReconnectS?: number
    /** a robot model file asked for without a reply is asked for again after this long (s; unset: 10) */
    meshRetryS?: number
}

export class DriveCore {
    readonly settings = persistentStore<ViewSettings>("lv.view", { profile: "", fixedFrame: "", follow: true, followFrame: "", followTurns: true, showStats: false, robotModel: true, maxLatencyMs: DEFAULT_MAX_LATENCY_MS, camerasIn3d: false, viewCube: true })
    /** the robot type in use and why (auto, or picked in Settings) */
    readonly robot: Store<{ type: RobotType; auto: boolean; reason: string }>
    readonly connection: Connection
    readonly drive: Drive
    /** the gamepad as a sensor_msgs.Joy (core/joy.ts) */
    readonly joy: JoyPublisher
    /** an arm's joint jog */
    readonly arm: ArmControl
    /** what runs (the dimos gateway's /active) */
    readonly runs = new RunWatch()
    /** called when the profile changes (ViewerApp's layers and framing follow it) */
    readonly profileChanged = new Set<(profile: RobotProfile) => void>()
    #profile: RobotProfile
    #robots: RobotsAnswer | null = null

    constructor() {
        const first = this.#resolve()
        this.#profile = profileFor(first.type)
        this.robot = new Store({ type: first.type, auto: true, reason: first.reason })
        this.connection = new Connection(this.profile.drive.deadmanMs)
        this.drive = new Drive(this.connection, this.profile)
        this.joy = new JoyPublisher(this.connection)
        // the lease also keeps the drive topics (and the gamepad's) to this viewer
        const leasePublish = () => this.connection.lease.setPublish([...this.drive.state.get().topics.map((topic) => zenohKey(topic.topic, topic.type)), dimosKey(joyTopic(), JOY_TYPE)])
        leasePublish()
        this.drive.state.subscribe(leasePublish)
        joySettings.subscribe(leasePublish)
        this.arm = new ArmControl(this.connection, this.drive, profileFor("arm").arm!)
        feedBattery(this.connection, () => this.profile.name)
        this.connection.status.subscribe(() => this.#updateDriveCandidates())
        this.connection.start()
        this.runs.state.subscribe(() => {
            this.#updateDriveCandidates()
            this.#updateRobot()
            this.#loadRobots()
        })
        this.runs.start()
        setInterval(() => this.#checkLink(), LINK_CHECK_MS)
        this.connection.status.subscribe(() => this.#updateRobot())
        // Settings → Robot here, in another viewer or by the agent
        this.settings.subscribe(() => this.#updateRobot())
        this.#updateRobot()
    }

    /** the robot profile in use (it changes with Settings → Robot, or when auto changes its mind) */
    get profile(): RobotProfile {
        return this.#profile
    }

    #checkLink() {
        const action = checkLink({
            state: this.connection.status.get().state,
            latencyMs: this.connection.latencyMs(),
            maxMs: maxLatencyOf(this.settings.get().maxLatencyMs),
            halt: this.drive.state.get().halt,
            hidden: typeof document !== "undefined" && document.hidden,
        })
        if (action && "halt" in action) {
            this.drive.halt(action.halt)
        } else if (action) {
            this.drive.resume()
        }
    }

    /** Reconnect: a latency hold only gets fresh drive publishers (the streams stay as they are); otherwise a new gateway session. */
    async reconnect() {
        this.drive.stop()
        if (this.drive.state.get().halt?.reason === "latency") {
            this.drive.resume()
            return
        }
        this.drive.halt({ reason: this.drive.state.get().halt?.reason ?? "latency", latencyMs: null, maxMs: maxLatencyOf(this.settings.get().maxLatencyMs) })
        this.drive.setReconnecting(true)
        try {
            await this.connection.reconnect()
            this.drive.resume()
        } catch (error) {
            console.warn("reconnect failed; the client keeps retrying", error)
            // the link watch resumes once the client's own retry connects
            this.drive.halt({ reason: "lost", latencyMs: null, maxMs: maxLatencyOf(this.settings.get().maxLatencyMs) })
        } finally {
            this.drive.setReconnecting(false)
        }
    }

    /** Always the wheeled base's controls (Jeff 10-26: no format picker; drones come later). The auto-detection
     * (core/robotType.ts resolveType) stays for when more formats return. */
    #resolve(): ResolvedType {
        return { type: "wheeled", reason: "the wheeled base controls" }
    }

    #updateRobot() {
        const resolved = this.#resolve()
        const auto = true
        const current = this.robot.get()
        if (current.type !== resolved.type || current.reason !== resolved.reason || current.auto !== auto) {
            this.robot.set({ type: resolved.type, auto, reason: resolved.reason })
        }
        if (resolved.type !== this.#profile.type) {
            this.#profile = profileFor(resolved.type)
            this.drive.setProfile(this.#profile)
            this.profileChanged.forEach((changed) => changed(this.#profile))
        }
        if (this.settings.get().robot !== resolved.type && typeof location !== "undefined") {
            this.settings.update({ robot: resolved.type })
        }
    }

    /** robots.json's types (the dimos gateway's catalog/robots) and Desktop's default robot (its settings), again whenever what runs changes. */
    #loadRobots() {
        const json = (path: string) => fetch(new URL(`../../${path}`, location.href)).then((response) => (response.ok ? response.json() : null)).catch(() => null)
        Promise.all([json("gateways/dimos/catalog/robots"), json("gateways/desktop/settings")])
            .then(([catalog, settings]) => robotsAnswer(catalog, settings))
            .then((answer: RobotsAnswer | null) => {
                if (answer && JSON.stringify(answer) !== JSON.stringify(this.#robots)) {
                    this.#robots = answer
                    this.#updateRobot()
                }
            })
            .catch(() => {})
    }

    #updateDriveCandidates() {
        const topics = this.connection.status.get().topics
        const onBridge = topics.filter((topic) => topic.type === "geometry_msgs.Twist").map((topic) => topic.name)
        this.drive.setRunning(this.runs.state.get().blueprints, onBridge)
        this.arm.setRunning(this.runs.state.get().blueprints, topics.filter((topic) => topic.type === "sensor_msgs.JointState").map((topic) => topic.name))
    }
}
