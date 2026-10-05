// A drone: W/S forward/back, A/D yaw, Q/E down/up (the vertical axis → linear.z), no strafe.
import type { RobotProfile } from "./types.ts"
import { turnKeys } from "./keys.ts"

const drone: RobotProfile = {
    type: "drone",
    name: "Drone",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/cmd_vel", "/movecmd_twist"],
        speeds: { linear: 1, angular: 1, vertical: 0.5 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: {
            ...turnKeys,
            KeyQ: { axis: "vertical", value: -1 },
            KeyE: { axis: "vertical", value: 1 },
        },
    },
    controls: [],
    cameras: { preferred: ["/video", "/color_image"], cameraInfo: {} },
}

export default drone
