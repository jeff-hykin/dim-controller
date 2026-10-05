// A wheeled base (Galaxea R1 Pro, Alfred): W/S drive, A/D turn, no strafe (Q/E do nothing).
import type { RobotProfile } from "./types.ts"
import { turnKeys } from "./keys.ts"

const wheeled: RobotProfile = {
    type: "wheeled",
    name: "Wheeled base",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/cmd_vel", "/tele_cmd_vel"],
        speeds: { linear: 0.4, angular: 0.6, vertical: 0 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: turnKeys,
    },
    controls: [],
    cameras: { preferred: ["/head_left/image", "/head_camera/color", "/color_image"], cameraInfo: {} },
}

export default wheeled
