// The 3D view menu's search (core/topicFilter.ts): every word typed must be in a topic's name, type or group, any case;
// the box shows once there are more than ten switches.
import { assertEquals } from "jsr:@std/assert@1"
import { FILTER_OVER, matchesQuery } from "../src/core/topicFilter.ts"

Deno.test("every word must match the name, the type or the group, in any case", () => {
    const odom = ["/odom", "nav_msgs.Odometry", "Pose + trail"]
    assertEquals(matchesQuery("odom", ...odom), true)
    assertEquals(matchesQuery("ODOMETRY", ...odom), true)
    assertEquals(matchesQuery("trail nav", ...odom), true, "words in different fields")
    assertEquals(matchesQuery("odom lidar", ...odom), false, "every word, not any")
    assertEquals(matchesQuery("", ...odom), true, "an empty box hides nothing")
    assertEquals(matchesQuery("   ", ...odom), true)
    assertEquals(matchesQuery("camera", "Camera in 3D"), true, "a group's own controls match by its label")
})

Deno.test("the search box shows past ten switches", () => {
    assertEquals(FILTER_OVER, 10)
})
