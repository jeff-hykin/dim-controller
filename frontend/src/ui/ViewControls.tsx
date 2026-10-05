// The 3D view's own camera buttons, over its corner: recenter (frame the robot, or the data) and top-down (straight
// down on the area around it). They move this page's camera directly; the agent's POST api/camera does the same in
// every open page.
import type { ViewerApp } from "../core/app.ts"
import { Icon } from "./icons.tsx"

export function ViewControls({ app }: { app: ViewerApp }) {
    return (
        <div className="view-controls" data-testid="view-controls">
            <button type="button" className="dim-btn icon view-control" title="Recenter on the robot" aria-label="Recenter" onClick={() => app.recenter()}>
                <Icon name="target" size={17} />
            </button>
            <button type="button" className="dim-btn icon view-control" title="Top-down view" aria-label="Top down" onClick={() => app.topDown()}>
                <Icon name="top" size={17} />
            </button>
        </div>
    )
}
