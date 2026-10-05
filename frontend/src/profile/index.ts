// The robot types the Robot picker offers, one profile each (the order is the picker's). A fork edits one, or adds its
// own and returns it from profileFor.
import dog from "./dog.ts"
import humanoid from "./humanoid.ts"
import wheeled from "./wheeled.ts"
import arm from "./arm.ts"
import drone from "./drone.ts"
import type { RobotProfile, RobotType } from "./types.ts"

export const profiles: RobotProfile[] = [dog, humanoid, wheeled, arm, drone]

export const profileFor = (type: RobotType): RobotProfile => profiles.find((profile) => profile.type === type) ?? dog
