// Whether there are arms to control: the Arm format, or a running ManipulationModule (an R1 Pro's arms). Joint control
// itself is in the 3D view (ui/ScenePanel.tsx JointControlArea).
import { plannerRunning, type RunState } from "../core/runs.ts"

export function armsPanelShown(robotType: string, runs: RunState, manipulationAvailable: boolean | null | undefined): boolean {
    return robotType === "arm" || plannerRunning(runs) || manipulationAvailable === true
}
