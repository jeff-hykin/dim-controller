// The usual ground-robot keys: W/S forward/back, A/D turn, Q/E strafe (REP-103: +y is left, +yaw counter-clockwise).
import type { RobotProfile } from "./types.ts"

export const turnKeys: RobotProfile["drive"]["keys"] = {
    KeyW: { axis: "forward", value: 1 },
    ArrowUp: { axis: "forward", value: 1 },
    KeyS: { axis: "forward", value: -1 },
    ArrowDown: { axis: "forward", value: -1 },
    KeyA: { axis: "turn", value: 1 },
    ArrowLeft: { axis: "turn", value: 1 },
    KeyD: { axis: "turn", value: -1 },
    ArrowRight: { axis: "turn", value: -1 },
}

export const groundKeys: RobotProfile["drive"]["keys"] = {
    ...turnKeys,
    KeyQ: { axis: "strafe", value: 1 },
    KeyE: { axis: "strafe", value: -1 },
}
