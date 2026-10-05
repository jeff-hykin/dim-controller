// A robot arm (xArm, Piper, OpenArm, A1Z, ... behind dimos's ControlCoordinator): no base to drive; the arm panel jogs
// joints (joint_command), the end effector (ee_twist_command) and the gripper (gripper_command). The keys are dimos's
// keyboard arm teleop's (dimos/teleop/keyboard/keyboard_teleop_module.py), and so are the end-effector speeds.
import type { RobotProfile } from "./types.ts"

const arm: RobotProfile = {
    type: "arm",
    name: "Arm",
    baseFrame: "world",
    fixedFrame: "",
    viewDistance: 1.6,
    drive: {
        cmdVelTopics: [],
        speeds: { linear: 0, angular: 0, vertical: 0 },
        boost: { linear: 1, angular: 1 },
        publishHz: 20,
        deadmanMs: 400,
        keys: {},
    },
    controls: [],
    arm: {
        linear: 0.05,
        angular: 0.5,
        jointSpeed: 0.4,
        keys: {
            KeyW: { ee: "x", value: 1 },
            KeyS: { ee: "x", value: -1 },
            KeyA: { ee: "y", value: 1 },
            KeyD: { ee: "y", value: -1 },
            KeyQ: { ee: "z", value: 1 },
            KeyE: { ee: "z", value: -1 },
            KeyR: { ee: "roll", value: 1 },
            KeyF: { ee: "roll", value: -1 },
            KeyT: { ee: "pitch", value: 1 },
            KeyG: { ee: "pitch", value: -1 },
            KeyY: { ee: "yaw", value: 1 },
            KeyH: { ee: "yaw", value: -1 },
            BracketLeft: { gripper: 1 },
            BracketRight: { gripper: 0 },
        },
        defaultLimit: [-Math.PI, Math.PI],
        limits: {},
    },
    cameras: { preferred: ["/color_image", "/camera/color", "/image"], cameraInfo: {} },
}

export default arm
