// The robot namespace (core/namespace.ts): keys into it and back, the topics a page sees, the namespaces found, frames
// stripped on the way in and given back on the way out, and the client that maps every key.
import { assertEquals } from "jsr:@std/assert@1"
import { cleanDomain, cleanNamespace, domainChange, domainOf, forgetFrames, fromWire, levelsOf, namespacedClient, namespacedTopics, pickDomain, prefixFrames, seenDomains, seenNamespaces, sentKeys, stripFrames, toWire, undomained } from "../src/core/namespace.ts"
import { parseKey, type Topic } from "../src/core/transport.ts"

const topic = (key: string) => parseKey(key) as Topic
const BUS = [
    topic("dimos/robot0/odom/nav_msgs.Odometry"),
    topic("dimos/robot0/cmd_vel/geometry_msgs.Twist"),
    topic("dimos/robot1/odom/nav_msgs.Odometry"),
    topic("dimos/global_map/sensor_msgs.PointCloud2"),
    topic("dimos/odom/nav_msgs.Odometry"),
    topic("dimos/file_info/std_msgs.String"),
    topic("dimos/file_info/go2/std_msgs.String"),
]

Deno.test("keys go into the namespace and back; Desktop's own keys and other prefixes don't", () => {
    forgetFrames()
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "robot1"), "dimos/robot1/cmd_vel/geometry_msgs.Twist")
    assertEquals(toWire("dimos/events/launch", "robot1"), "dimos/events/launch")
    assertEquals(toWire("dim-controller/frontend/x", "robot1"), "dim-controller/frontend/x")
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", ""), "dimos/cmd_vel/geometry_msgs.Twist")
    assertEquals(fromWire("dimos/robot1/odom/nav_msgs.Odometry", "robot1"), "dimos/odom/nav_msgs.Odometry")
    assertEquals(fromWire("dimos/robot0/odom/nav_msgs.Odometry", "robot1"), "dimos/robot0/odom/nav_msgs.Odometry")
})

Deno.test("namespaces on the bus: a topic's first part, unless that part is a topic itself", () => {
    assertEquals(seenNamespaces(BUS), ["robot0", "robot1"])
})

Deno.test("nested namespaces: names, levels innermost first", () => {
    assertEquals([cleanNamespace("fleet/robot1"), cleanNamespace("/fleet/"), cleanNamespace("a b"), cleanNamespace("a//b")], ["fleet/robot1", "fleet", "", ""])
    assertEquals(levelsOf("fleet/robot1"), ["fleet/robot1", "fleet", ""])
    assertEquals(levelsOf(""), [""])
})

const NESTED = [
    topic("dimos/fleet/robot0/odom/nav_msgs.Odometry"),
    topic("dimos/fleet/robot0/cmd_vel/geometry_msgs.Twist"),
    topic("dimos/fleet/robot1/odom/nav_msgs.Odometry"),
    topic("dimos/fleet/robot1/tf/tf2_msgs.TFMessage"),
    topic("dimos/fleet/map/nav_msgs.OccupancyGrid"),
    topic("dimos/fleet/odom/nav_msgs.Odometry"),
    topic("dimos/global_map/sensor_msgs.PointCloud2"),
]

Deno.test("nested: the robot's own topics, then its fleet's shared ones, then the global ones; inner names win, keys route back", () => {
    assertEquals(seenNamespaces(NESTED), ["fleet", "fleet/robot0", "fleet/robot1"])
    const seen = namespacedTopics(NESTED, "fleet/robot1")
    assertEquals(seen.map((one) => one.key), [
        "dimos/odom/nav_msgs.Odometry",
        "dimos/tf/tf2_msgs.TFMessage",
        "dimos/map/nav_msgs.OccupancyGrid",
        "dimos/global_map/sensor_msgs.PointCloud2",
    ])
    assertEquals(toWire("dimos/odom/nav_msgs.Odometry", "fleet/robot1"), "dimos/fleet/robot1/odom/nav_msgs.Odometry")
    assertEquals(toWire("dimos/map/nav_msgs.OccupancyGrid", "fleet/robot1"), "dimos/fleet/map/nav_msgs.OccupancyGrid")
    assertEquals(toWire("dimos/global_map/sensor_msgs.PointCloud2", "fleet/robot1"), "dimos/global_map/sensor_msgs.PointCloud2")
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "fleet/robot1"), "dimos/fleet/robot1/cmd_vel/geometry_msgs.Twist")
    assertEquals(fromWire("dimos/fleet/map/nav_msgs.OccupancyGrid", "fleet/robot1"), "dimos/map/nav_msgs.OccupancyGrid")
    // the fleet level: its own topics, not a robot's
    assertEquals(namespacedTopics(NESTED, "fleet").map((one) => one.key), ["dimos/map/nav_msgs.OccupancyGrid", "dimos/odom/nav_msgs.Odometry", "dimos/global_map/sensor_msgs.PointCloud2"])
    forgetFrames()
})

Deno.test("nested frames: the robot's and its fleet's lose their prefix, and get the same one back", () => {
    forgetFrames()
    const tf = { transforms: [{ header: { frame_id: "fleet/map" }, child_frame_id: "fleet/robot1/odom" }, { header: { frame_id: "fleet/robot1/odom" }, child_frame_id: "fleet/robot1/base_link" }] }
    stripFrames(tf, "fleet/robot1")
    assertEquals(tf.transforms.map((one) => [one.header.frame_id, one.child_frame_id]), [["map", "odom"], ["odom", "base_link"]])
    assertEquals([prefixFrames({ header: { frame_id: "map" } }, "fleet/robot1").header.frame_id, prefixFrames({ header: { frame_id: "odom" } }, "fleet/robot1").header.frame_id], ["fleet/map", "fleet/robot1/odom"])
})

Deno.test("a namespace's page sees its topics by plain names and the shared ones, never another robot's", () => {
    assertEquals(namespacedTopics(BUS, "robot0").map((one) => one.key), [
        "dimos/odom/nav_msgs.Odometry",
        "dimos/cmd_vel/geometry_msgs.Twist",
        "dimos/global_map/sensor_msgs.PointCloud2",
        "dimos/file_info/std_msgs.String",
        "dimos/file_info/go2/std_msgs.String",
    ])
    assertEquals(namespacedTopics(BUS, ""), BUS)
})

Deno.test("frames lose the namespace coming in and get it back going out; shared frames stay shared", () => {
    forgetFrames()
    const tf = { transforms: [{ header: { frame_id: "robot1/odom" }, child_frame_id: "robot1/base_link" }, { header: { frame_id: "world" }, child_frame_id: "robot1/odom" }] }
    stripFrames(tf, "robot1")
    assertEquals(tf.transforms.map((one) => [one.header.frame_id, one.child_frame_id]), [["odom", "base_link"], ["world", "odom"]])
    const goal = { header: { frame_id: "odom", stamp: { sec: 1 } }, pose: { position: { x: 1 } } }
    const sent = prefixFrames(goal, "robot1")
    assertEquals([sent.header.frame_id, goal.header.frame_id, sent.pose === goal.pose], ["robot1/odom", "odom", true])
    assertEquals(prefixFrames({ header: { frame_id: "world" } }, "robot1").header.frame_id, "world")
    // bytes are never walked
    const cloud = { header: { frame_id: "robot1/lidar" }, data: new Uint8Array(4) }
    assertEquals(stripFrames(cloud, "robot1").header.frame_id, "lidar")
})

Deno.test("the client maps every key: subscribe (and the messages' keys back), publisher, put, the lease", () => {
    const calls: unknown[][] = []
    const raw = {
        state: "connected",
        subscribe(key: string, _options: unknown, callback: (message: { key: string }) => void) {
            calls.push(["subscribe", key])
            callback({ key })
        },
        publisher: (key: string) => calls.push(["publisher", key]),
        put: (key: string) => calls.push(["put", key]),
        lease: (options: { publish: string[] }) => calls.push(["lease", options.publish]),
        listTopics: (filter: string) => calls.push(["listTopics", filter]),
    }
    const client = namespacedClient(raw, "robot0")
    const heard: string[] = []
    client.subscribe("dimos/odom/nav_msgs.Odometry", {}, (message) => heard.push(message.key))
    client.publisher("dimos/cmd_vel/geometry_msgs.Twist")
    client.put("dimos/goal/geometry_msgs.PoseStamped")
    client.lease({ publish: ["dimos/cmd_vel/geometry_msgs.Twist"] })
    client.listTopics("dimos/**")
    assertEquals(calls, [
        ["subscribe", "dimos/robot0/odom/nav_msgs.Odometry"],
        ["publisher", "dimos/robot0/cmd_vel/geometry_msgs.Twist"],
        ["put", "dimos/robot0/goal/geometry_msgs.PoseStamped"],
        ["lease", ["dimos/robot0/cmd_vel/geometry_msgs.Twist"]],
        ["listTopics", "dimos/**"],
    ])
    assertEquals([heard, client.state], [["dimos/odom/nav_msgs.Odometry"], "connected"])
})

// ---- the run domain: a hosted run's streams at dimos-domains/<run id>/… ----

Deno.test("run domain: keys go into it last and come out of it first; Desktop's keys and dimos's RPCs stay out", () => {
    forgetFrames()
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "", "20261120-101500-go2"), "dimos-domains/20261120-101500-go2/cmd_vel/geometry_msgs.Twist")
    assertEquals(toWire("dimos/**", "", "run1"), "dimos-domains/run1/**")
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "robot1", "run1"), "dimos-domains/run1/robot1/cmd_vel/geometry_msgs.Twist")
    assertEquals(toWire("dimos/events/launch", "", "run1"), "dimos/events/launch")
    assertEquals(toWire("dimos/rpc/Go2/stand", "", "run1"), "dimos/rpc/Go2/stand")
    assertEquals(toWire("dim-controller/frontend/x", "", "run1"), "dim-controller/frontend/x")
    assertEquals(fromWire("dimos-domains/run1/odom/nav_msgs.Odometry", "", "run1"), "dimos/odom/nav_msgs.Odometry")
    assertEquals(fromWire("dimos-domains/run1/robot1/odom/nav_msgs.Odometry", "robot1", "run1"), "dimos/odom/nav_msgs.Odometry")
    assertEquals(fromWire("dimos-domains/run2/odom/nav_msgs.Odometry", "", "run1"), "dimos-domains/run2/odom/nav_msgs.Odometry")
    // without one, exactly as before
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "", ""), "dimos/cmd_vel/geometry_msgs.Twist")
    assertEquals(fromWire("dimos/odom/nav_msgs.Odometry", "", ""), "dimos/odom/nav_msgs.Odometry")
})

Deno.test("run domain: domains on the bus, a domained key's plain form", () => {
    assertEquals(seenDomains(["dimos-domains/b/odom/nav_msgs.Odometry", "dimos-domains/a/x/y.Z", "dimos/odom/nav_msgs.Odometry", "dimos-domains/b/tf/tf2_msgs.TFMessage"]), ["a", "b"])
    assertEquals([domainOf("dimos-domains/r.1-x/odom/T.T"), domainOf("dimos/odom/T.T")], ["r.1-x", ""])
    assertEquals(undomained("dimos-domains/run1/color_image/sensor_msgs.Image"), "dimos/color_image/sensor_msgs.Image")
    assertEquals([cleanDomain("20261120-101500-go2"), cleanDomain("a/b"), cleanDomain("")], ["20261120-101500-go2", "", ""])
})

Deno.test("run domain: the running run's own when it's there, none for a plain run, else the current one or the newest", () => {
    assertEquals(pickDomain(["20261120-090000-a", "20261120-101500-go2"], "20261120-090000-a", ""), "20261120-090000-a")
    // a plain `dimos run` is running: its streams are at dimos/, whatever else is on the bus
    assertEquals(pickDomain(["20261120-090000-a"], "20261120-110000-plain", "20261120-090000-a"), "")
    // no run here (this machine only hosts a fragment, or there's no Desktop)
    assertEquals(pickDomain(["20261120-090000-a", "20261120-101500-go2"], null, ""), "20261120-101500-go2")
    assertEquals(pickDomain(["20261120-090000-a", "20261120-101500-go2"], null, "20261120-090000-a"), "20261120-090000-a")
    assertEquals(pickDomain([], null, "gone"), "")
})

Deno.test("run domain: a change reloads, except leaving one the page just came up in before its run has had time to show", () => {
    assertEquals(domainChange(["run1"], "run1", "", 2000, 20000), "run1")
    assertEquals(domainChange(["run1"], "run1", "run1", 2000, 20000), null)
    assertEquals(domainChange([], null, "", 2000, 20000), null)
    assertEquals(domainChange([], null, "run1", 2000, 20000), null)
    assertEquals(domainChange([], null, "run1", 25000, 20000), "")
    assertEquals(domainChange(["run2"], "run2", "run1", 2000, 20000), "run2")
    assertEquals(domainChange(["run1"], "plain", "run1", 2000, 20000), "")
})

Deno.test("run domain: the client maps every key into it, and the messages' keys back", () => {
    forgetFrames()
    const calls: unknown[][] = []
    const raw = {
        subscribe(key: string, _options: unknown, callback: (message: { key: string }) => void) {
            calls.push(["subscribe", key])
            callback({ key: key.replace("**", "odom/nav_msgs.Odometry") })
        },
        publisher: (key: string) => calls.push(["publisher", key]),
        lease: (options: { publish: string[] }) => calls.push(["lease", options.publish]),
        listTopics: (filter: string) => calls.push(["listTopics", filter]),
    }
    const client = namespacedClient(raw, "", "run1")
    const heard: string[] = []
    client.subscribe("dimos/**", {}, (message) => heard.push(message.key))
    client.publisher("dimos/cmd_vel/geometry_msgs.Twist")
    client.lease({ publish: ["dimos/tele_cmd_vel/geometry_msgs.Twist"] })
    client.listTopics("dimos-domains/**")
    assertEquals(calls, [
        ["subscribe", "dimos-domains/run1/**"],
        ["publisher", "dimos-domains/run1/cmd_vel/geometry_msgs.Twist"],
        ["lease", ["dimos-domains/run1/tele_cmd_vel/geometry_msgs.Twist"]],
        ["listTopics", "dimos-domains/**"],
    ])
    assertEquals(heard, ["dimos/odom/nav_msgs.Odometry"])
    calls.length = 0
    namespacedClient(raw, "", "").publisher("dimos/goal/geometry_msgs.PointStamped")
    assertEquals(calls, [["publisher", "dimos/goal/geometry_msgs.PointStamped"]])
    assertEquals([...sentKeys].sort(), ["dimos/cmd_vel/geometry_msgs.Twist", "dimos/goal/geometry_msgs.PointStamped", "dimos/goal/geometry_msgs.PoseStamped", "dimos/tele_cmd_vel/geometry_msgs.Twist"])
})

Deno.test("run domain: a domain only the page's own sends are in (a dead run it keeps asking) isn't one", () => {
    const sent = new Set(["dimos/named_locations_request/std_msgs.String"])
    assertEquals(seenDomains(["dimos-domains/old/named_locations_request/std_msgs.String"], sent), [])
    assertEquals(seenDomains(["dimos-domains/old/named_locations_request/std_msgs.String", "dimos-domains/new/odom/nav_msgs.Odometry"], sent), ["new"])
})
