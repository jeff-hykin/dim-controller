// Which run is a simulator, which one, and which robot: the 3D view's sim model and the Sim panel follow it.
import { assertEquals } from "jsr:@std/assert@1"
import { dimsimUrl, simOf, simOfRun } from "../src/core/sim.ts"

const go2Modules = [{ name: "go2connection", class: "dimos.robot.unitree.go2.connection.GO2Connection" }]
const g1SimModules = [{ name: "g1simconnection", class: "dimos.robot.unitree.g1.mujoco_sim.G1SimConnection" }]

Deno.test("unitree-go2 with simulation: mujoco is the MuJoCo Go2", () => {
    assertEquals(simOfRun({ blueprint: "unitree-go2", overrides: { simulation: "mujoco" }, modules: go2Modules }), { engine: "mujoco", blueprint: "unitree-go2", robot: "go2" })
})

Deno.test("the G1 sim blueprints are MuJoCo whatever `simulation` says (G1SimConnection)", () => {
    assertEquals(simOfRun({ blueprint: "unitree-g1-sim", overrides: {}, modules: g1SimModules }), { engine: "mujoco", blueprint: "unitree-g1-sim", robot: "g1" })
})

Deno.test("a real robot (no simulation override, no sim module) is not a sim", () => {
    assertEquals(simOfRun({ blueprint: "unitree-go2", overrides: { robot_ip: "192.168.123.161" }, modules: go2Modules }), null)
    assertEquals(simOfRun({ blueprint: "unitree-g1", overrides: {}, modules: null }), null)
})

Deno.test("DimSim: its port, headless flag and scene, with dimos's defaults for what wasn't set", () => {
    assertEquals(simOfRun({ blueprint: "unitree-go2", overrides: { simulation: "dimsim", dimsim_headless: false, dimsim_port: 8091 }, modules: go2Modules }), {
        engine: "dimsim",
        blueprint: "unitree-go2",
        robot: "go2",
        dimsim: { port: 8091, headless: false, scene: "apartment" },
    })
    assertEquals(simOfRun({ blueprint: "unitree-go2-agentic", overrides: { simulation: "dimsim" }, modules: null })?.dimsim, { port: 8090, headless: true, scene: "apartment" })
})

Deno.test("a terminal run's registry overrides with dashes and string values count too", () => {
    assertEquals(simOfRun({ blueprint: "unitree-go2", overrides: { simulation: "dimsim", "dimsim-headless": "false", "dimsim-scene": "empty" }, modules: null })?.dimsim, { port: 8090, headless: false, scene: "empty" })
})

Deno.test("the first sim among the running blueprints", () => {
    const sim = simOf([
        { blueprint: "dual-xarm6-planner-coordinator", overrides: {}, modules: [] },
        { blueprint: "unitree-g1-basic-sim", overrides: {}, modules: g1SimModules },
    ])
    assertEquals(sim?.robot, "g1")
    assertEquals(simOf([{ blueprint: "dual-xarm6-planner-coordinator", overrides: {}, modules: [] }]), null)
})

Deno.test("DimSim's page is on the host this page came from, at its port; MuJoCo has none", () => {
    const dimsim = simOfRun({ blueprint: "unitree-go2", overrides: { simulation: "dimsim", dimsim_headless: false }, modules: null })!
    assertEquals(dimsimUrl(dimsim, { protocol: "http:", hostname: "127.0.0.1" }), "http://127.0.0.1:8090/")
    assertEquals(dimsimUrl(dimsim, { protocol: "http:", hostname: "::1" }), "http://[::1]:8090/")
    assertEquals(dimsimUrl({ engine: "mujoco", blueprint: "unitree-go2", robot: "go2" }, { protocol: "http:", hostname: "127.0.0.1" }), null)
})
