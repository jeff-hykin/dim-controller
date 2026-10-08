// Whether what's running is a simulator, which one and which robot, from Desktop's /dimos/runs (each run's GlobalConfig
// overrides) and the blueprint's modules: dimos's MuJoCo sim (`simulation: mujoco` on unitree-go2, the unitree-g1 *-sim
// blueprints' G1SimConnection) or DimSim (`simulation: dimsim`, a browser sim on its own port). The 3D view draws the
// sim's robot model (render/simModel.ts) and the Sim panel (ui/SimPanel.tsx) shows DimSim's own page.

export type SimEngine = "mujoco" | "dimsim"
/** the robots dimos simulates (each has a baked model: public/robots/sim_<robot>.glb) */
export type SimRobot = "go2" | "g1"

export interface SimInfo {
    engine: SimEngine
    blueprint: string
    robot: SimRobot | null
    /** DimSim's page (the bridge server dimos starts): its port, and whether dimos opened it headless itself */
    dimsim?: { port: number; headless: boolean; scene: string }
}

/** A run's modules as the blueprint metadata gives them (name, Python class). */
export interface SimModule {
    name?: string
    class?: string
}

export interface SimRun {
    blueprint: string
    /** its GlobalConfig overrides (the registry's config_overrides, the Launcher's launch.overrides) */
    overrides: Record<string, unknown>
    modules: SimModule[] | null
}

const DIMSIM_DEFAULTS = { port: 8090, headless: true, scene: "apartment" }

const truthy = (value: unknown) => value === true || (typeof value === "string" && /^(1|true|yes|on)$/i.test(value))

/** An override by its GlobalConfig name (a terminal run's registry may spell it with dashes, as on the command line). */
function setting(overrides: Record<string, unknown>, name: string): unknown {
    return overrides[name] ?? overrides[name.replaceAll("_", "-")]
}

function robotOf(blueprint: string, modules: SimModule[]): SimRobot | null {
    const names = [blueprint, ...modules.map((module) => `${module.name ?? ""} ${module.class ?? ""}`)].join(" ").toLowerCase()
    if (/\bg1|g1sim|unitree[-_]g1/.test(names)) {
        return "g1"
    }
    if (/go2|go1/.test(names)) {
        return "go2"
    }
    return null
}

/** The run's simulator, or null for a real robot (or a replay). */
export function simOfRun(run: SimRun): SimInfo | null {
    const modules = run.modules ?? []
    const robot = robotOf(run.blueprint, modules)
    const simulation = String(setting(run.overrides, "simulation") ?? "").toLowerCase()
    if (simulation === "dimsim") {
        const port = Number(setting(run.overrides, "dimsim_port"))
        const headless = setting(run.overrides, "dimsim_headless")
        const scene = setting(run.overrides, "dimsim_scene")
        return {
            engine: "dimsim",
            blueprint: run.blueprint,
            robot,
            dimsim: {
                port: Number.isInteger(port) && port > 0 ? port : DIMSIM_DEFAULTS.port,
                headless: headless === undefined || headless === null || headless === "" ? DIMSIM_DEFAULTS.headless : truthy(headless),
                scene: typeof scene === "string" && scene ? scene : DIMSIM_DEFAULTS.scene,
            },
        }
    }
    // go2's connection: `simulation` mujoco (or true); the G1 sim blueprints run G1SimConnection whatever it says
    const simModule = modules.some((module) => /(^|\.)(G1SimConnection|MujocoConnection)$/i.test(module.class ?? "") || /^(g1simconnection|mujococonnection)$/i.test(module.name ?? ""))
    if (simulation === "mujoco" || simulation === "true" || simModule) {
        return { engine: "mujoco", blueprint: run.blueprint, robot }
    }
    return null
}

/** The first running blueprint that's a sim, or null. */
export function simOf(runs: SimRun[]): SimInfo | null {
    for (const run of runs) {
        const sim = simOfRun(run)
        if (sim) {
            return sim
        }
    }
    return null
}

/** DimSim's page on the machine this page came from (Desktop runs dimos there, and dimos runs DimSim). */
export function dimsimUrl(sim: SimInfo, here: { protocol: string; hostname: string }): string | null {
    if (sim.engine !== "dimsim" || !sim.dimsim) {
        return null
    }
    const host = here.hostname.includes(":") ? `[${here.hostname}]` : here.hostname
    return `http://${host}:${sim.dimsim.port}/`
}

export function sameSim(a: SimInfo | null, b: SimInfo | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}
