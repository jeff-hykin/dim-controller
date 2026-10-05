// Wires the core together (no React): bridge connection, TF, the 3D view, layers, camera streams, drive.
// The UI reads the stores; window.__lv exposes this for tests.
import * as THREE from "three"
import { Connection } from "./transport.ts"
import { TfTree } from "./tf.ts"
import { feedTf } from "./tfFeed.ts"
import { feedBattery } from "./batteryFeed.ts"
import { Viewer } from "./render/viewer.ts"
import { FrameHighlight } from "./render/frameHighlight.ts"
import { LayerManager } from "./layers/manager.ts"
import { VideoSources } from "./video.ts"
import { Drive } from "./drive.ts"
import { AgentLink } from "./agent.ts"
import { LocationLabels } from "./labels.ts"
import { robotPose } from "./robot.ts"
import { RunWatch } from "./runs.ts"
import { persistentStore, Store } from "./store.ts"
import { profiles } from "../profile/index.ts"
import type { RobotProfile } from "../profile/types.ts"

export interface ViewSettings {
    profile: string
    /** "" = the profile's, else picked from the tree */
    fixedFrame: string
    follow: boolean
    showStats: boolean
}

export class ViewerApp {
    readonly connection: Connection
    readonly tf = new TfTree()
    readonly viewer: Viewer
    /** the TF frame picked out in the view (the TF panel's hovered row) */
    readonly highlight: FrameHighlight
    readonly video: VideoSources
    readonly layers: LayerManager
    readonly settings = persistentStore<ViewSettings>("lv.view", { profile: profiles[0].name, fixedFrame: "", follow: true, showStats: false })
    readonly profile: RobotProfile
    readonly drive: Drive
    /** live annotations and the agent's captures (server/src/annotations.rs) */
    readonly agent: AgentLink
    /** right-click location labels (server/src/labels.rs) */
    readonly labels: LocationLabels
    /** what's running (Desktop's /dimos/runs, live on its zenoh events): the first-run messages and the drive topic */
    readonly runs = new RunWatch()
    /** the fixed frame in use and where the robot is (for the UI) */
    readonly frameInfo = new Store<{ fixedFrame: string; robotFound: boolean }>({ fixedFrame: "", robotFound: false })
    /** the robot's pose in the fixed frame, or null (updated every frame) */
    robotMatrix: THREE.Matrix4 | null = null
    #framed = false
    /** where the robot is now (followed or not), for recentering */
    #robotPosition: THREE.Vector3 | null = null

    constructor(host: HTMLElement) {
        this.profile = profiles.find((profile) => profile.name === this.settings.get().profile) ?? profiles[0]
        this.connection = new Connection(this.profile.drive.deadmanMs)
        this.viewer = new Viewer(host, () => this.connection.bridgeNow())
        this.highlight = new FrameHighlight(this.viewer, this.tf)
        this.video = new VideoSources(this.connection)
        this.layers = new LayerManager(this.viewer, this.tf, this.connection, this.video, this.profile)
        this.drive = new Drive(this.connection, this.profile)
        feedTf(this.connection, this.tf, this.viewer)
        feedBattery(this.connection, () => this.profile.name)
        this.connection.status.subscribe(() => this.#updateDriveCandidates())
        this.viewer.onFrame(() => this.#eachFrame())
        this.connection.start()
        this.labels = new LocationLabels(this)
        this.agent = new AgentLink(this)
        this.runs.state.subscribe(() => this.#updateDriveCandidates())
        this.runs.start()
        // another viewer (or the agent) switched the robot profile: start over on it
        this.settings.subscribe(() => {
            const wanted = this.settings.get().profile
            if (wanted !== this.profile.name && profiles.some((profile) => profile.name === wanted)) {
                location.reload()
            }
        })
    }

    #eachFrame() {
        const chosen = this.settings.get().fixedFrame || this.profile.fixedFrame
        const fixedFrame = chosen || this.tf.defaultFixedFrame()
        if (fixedFrame !== this.viewer.fixedFrame) {
            this.viewer.fixedFrame = fixedFrame
            this.viewer.requestRender()
        }
        const base = this.tf.lookup(this.profile.baseFrame, fixedFrame)
        const robot = base ?? robotPose.matrix
        this.robotMatrix = robot
        const position = robot ? new THREE.Vector3().setFromMatrixPosition(robot) : null
        this.#robotPosition = position
        if (position && !this.#framed) {
            this.#framed = true
            this.viewer.followTarget = position
            this.viewer.frame(position, 7)
        }
        this.viewer.followTarget = this.settings.get().follow ? position : null
        const info = this.frameInfo.get()
        if (info.fixedFrame !== fixedFrame || info.robotFound !== !!position) {
            this.frameInfo.set({ fixedFrame, robotFound: !!position })
        }
    }

    /** The backend asked every viewer to move the camera (POST api/camera, the agent's way; the page's own buttons call recenter / topDown directly). */
    applyCamera(event: { action: string; target?: number[] | null; distance?: number | null }) {
        if (event.action === "recenter") {
            this.recenter()
        } else if (event.action === "topDown") {
            this.topDown()
        } else if (event.action === "lookAt" && event.target?.length === 3) {
            this.settings.update({ follow: false })
            this.viewer.frame(new THREE.Vector3(event.target[0], event.target[1], event.target[2]), event.distance ?? 7)
        }
    }

    /** Frames the robot (7 m away), or without one the data that's drawn, or else the origin. */
    recenter() {
        if (this.#robotPosition) {
            this.viewer.frame(this.#robotPosition.clone(), 7)
            return
        }
        const bounds = this.viewer.dataBounds()
        if (bounds) {
            const size = bounds.getSize(new THREE.Vector3())
            this.viewer.frame(bounds.getCenter(new THREE.Vector3()), THREE.MathUtils.clamp(Math.max(size.x, size.y, size.z) * 1.2, 4, 300))
            return
        }
        this.viewer.frame(new THREE.Vector3(), 7)
    }

    /**
     * Straight down on the area around the robot (the data within 15 m of it, at least 12 m and at most 30 m across),
     * or without one on all the data that's drawn.
     */
    topDown() {
        const bounds = this.viewer.dataBounds()
        const robot = this.#robotPosition?.clone() ?? null
        if (robot) {
            let extent = 20
            if (bounds) {
                const near = bounds.clone().intersect(new THREE.Box3().setFromCenterAndSize(robot, new THREE.Vector3(30, 30, 1e6)))
                if (!near.isEmpty()) {
                    const size = near.getSize(new THREE.Vector3())
                    extent = THREE.MathUtils.clamp(Math.max(size.x, size.y), 12, 30)
                }
            }
            this.viewer.topDown(robot, extent)
        } else if (bounds) {
            const size = bounds.getSize(new THREE.Vector3())
            const center = bounds.getCenter(new THREE.Vector3())
            this.viewer.topDown(center.setZ(bounds.min.z), THREE.MathUtils.clamp(Math.max(size.x, size.y), 6, 400))
        } else {
            this.viewer.topDown(new THREE.Vector3(), 20)
        }
    }

    #updateDriveCandidates() {
        const onBridge = this.connection.status.get().topics.filter((topic) => topic.type === "geometry_msgs.Twist").map((topic) => topic.name)
        this.drive.setRunning(this.runs.state.get().blueprints, onBridge)
    }
}
