// A legged base (Unitree Go2, Spot, M20): WASD drive, Q/E strafe. The default when nothing says otherwise.
import type { RobotProfile } from "./types.ts"
import { groundKeys } from "./keys.ts"

const dog: RobotProfile = {
    type: "dog",
    name: "Dog",
    baseFrame: "base_link",
    fixedFrame: "",
    drive: {
        cmdVelTopics: ["/tele_cmd_vel", "/cmd_vel"],
        speeds: { linear: 0.5, angular: 2.3, vertical: 0 },
        boost: { linear: 2, angular: 0.5 },
        publishHz: 20,
        deadmanMs: 400,
        keys: groundKeys,
    },
    controls: [],
    cameras: { preferred: ["/color_image", "/camera/color", "/image"], cameraInfo: {} },
}

export default dog
