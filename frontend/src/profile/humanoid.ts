// A humanoid (Unitree G1): WASD walk, Q/E side-step, slower than a dog.
import type { RobotProfile } from "./types.ts"
import { groundKeys } from "./keys.ts"

const humanoid: RobotProfile = {
    type: "humanoid",
    name: "Humanoid",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/tele_cmd_vel", "/cmd_vel"],
        speeds: { linear: 0.3, angular: 0.5, vertical: 0 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: groundKeys,
    },
    controls: [],
    cameras: { preferred: ["/color_image", "/camera/color", "/image"], cameraInfo: {} },
}

export default humanoid
