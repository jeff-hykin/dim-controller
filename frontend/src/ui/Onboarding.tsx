// First-run messages over the 3D view: what's missing before the Controller can show or drive a robot, and a button to
// the place that fixes it (the Launcher, filtered to blueprints that take cmd_vel). Live: they follow Desktop's `runs`
// events (core/runs.ts) and the bridge's state, so the message goes away as soon as a blueprint starts.
import { useEffect, useRef, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { emptyState, type EmptyStateOptions } from "../dim-app/desktop.js"

const LAUNCH_DRIVABLE = { kind: "blueprint" as const, stream: "cmd_vel" }
const REPLAY_HINT = "No robot? Turn on replay in the Launcher to drive a recorded one."

/** desktop.js's emptyState, centered over the view (above Desktop's dock). */
export function EmptyLayer(props: EmptyStateOptions) {
    const host = useRef<HTMLDivElement>(null)
    const key = JSON.stringify({ ...props, actions: props.actions?.map((action) => action.label) })
    const latest = useRef(props)
    latest.current = props
    useEffect(() => {
        host.current?.replaceChildren(emptyState(latest.current))
    }, [key])
    return <div ref={host} className="dim-empty-layer" />
}

export type Onboarding = { message: EmptyStateOptions | null; blocksDriving: boolean }

/** Which first-run message applies now (null: none), and whether the drive bar should step aside for it. */
export function useOnboarding(app: ViewerApp): Onboarding {
    const runs = useStore(app.runs.state)
    const connection = useStore(app.connection.status)
    const [dismissed, setDismissed] = useState<string | null>(null)
    const runningKey = runs.running.join(",")
    const twistOnBridge = connection.topics.some((topic) => topic.type === "geometry_msgs.Twist")

    if (connection.state === "lost") {
        return {
            blocksDriving: false,
            message: {
                testId: "onboard-bridge-lost",
                tone: "warn",
                label: "No connection",
                title: "Can't reach the robot data bridge",
                body: "Desktop's zenoh-web bridge is down or blocked on this network, so no robot data can arrive. It keeps retrying by itself.",
                actions: [
                    { label: "Try again", onClick: () => location.reload() },
                    { label: "Open Settings", app: "settings", primary: false },
                ],
            },
        }
    }
    if (!runs.known || !runs.desktop) {
        // not inside Desktop (dev server, remote robot): nothing to point at
        return { message: null, blocksDriving: false }
    }
    if (runs.dimosInstalled === false) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-dimos",
                tone: "warn",
                label: "dimOS not installed",
                title: "dimOS isn't installed yet",
                body: "The Controller drives robots that a dimOS blueprint connects to. The Launcher installs dimOS (a few minutes) and then runs blueprints.",
                actions: [{ label: "Open the Launcher", app: "launcher", params: LAUNCH_DRIVABLE }],
            },
        }
    }
    if (runs.running.length === 0 && runs.starting) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-starting",
                busy: true,
                label: "Starting",
                title: `Starting ${runs.starting}`,
                body: "This takes a few seconds; the robot shows up here when it's running.",
                actions: [{ label: "Open the Launcher", app: "launcher", primary: false }],
            },
        }
    }
    if (runs.running.length === 0) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-blueprint",
                label: "No blueprint running",
                title: "You need to launch a blueprint with a cmd_vel topic before you can control a robot",
                body: `A blueprint is the software that connects to a robot. ${REPLAY_HINT}`,
                actions: [{ label: "Open the Launcher", app: "launcher", params: LAUNCH_DRIVABLE }],
            },
        }
    }
    const names = runs.running.join(", ")
    if (runs.driveInputs.length === 0 && !twistOnBridge && dismissed !== runningKey) {
        return {
            blocksDriving: true,
            message: {
                testId: "onboard-no-cmd-vel",
                tone: "warn",
                label: "Nothing to drive",
                title: `${names} is running, but it has no cmd_vel topic, so there's nothing to drive`,
                body: "You can still look at its topics here. To drive, launch a blueprint that takes cmd_vel.",
                actions: [
                    { label: "Open the Launcher", app: "launcher", params: LAUNCH_DRIVABLE },
                    { label: "Just view", onClick: () => setDismissed(runningKey), primary: false },
                ],
            },
        }
    }
    if (connection.topics.length === 0) {
        return {
            blocksDriving: false,
            message: {
                testId: "onboard-waiting-topics",
                busy: true,
                label: "Waiting for data",
                title: `Waiting for ${names}'s topics`,
                body: "They appear a few seconds after a blueprint starts. If nothing comes, its log in the Launcher says why.",
                actions: [{ label: "Open the Launcher", app: "launcher", primary: false }],
            },
        }
    }
    return { message: null, blocksDriving: false }
}
