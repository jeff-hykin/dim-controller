// The page: one bar along the bottom (ui/TopBar.tsx: STOP, the link, the chips that matter, Record, Settings) over the
// workspace (a main view between a left and a right rail, panels that can float over it; ui/workspace.ts). Settings
// opens the drawer that adds panels (ui/SettingsDrawer.tsx); held drive keys show over the main view's bottom.
// Every panel has the same frame and the same header actions (ui/Panel.tsx); everything is also in the `/` palette, and `?` lists the keys. On a
// phone one panel shows at a time and driving is two thumb sticks.
import { type PointerEvent, useEffect, useRef, useState } from "react"
import { ViewerApp } from "./core/app.ts"
import { Store, useStore } from "./core/store.ts"
import { TopBar } from "./ui/TopBar.tsx"
import { KeyOverlay } from "./ui/KeyOverlay.tsx"
import { openSettingsDrawer, SettingsDrawer } from "./ui/SettingsDrawer.tsx"
import { ActionBar } from "./ui/ActionBar.tsx"
import { GlassWindow } from "./ui/GlassToGlass.tsx"
import { PhoneCorners } from "./ui/PhoneCorners.tsx"
import { ZoomDebug } from "./ui/ZoomDebug.tsx"
import { CameraPanels, cameraLayout, useCameraActions } from "./ui/CameraPanels.tsx"
import { MapPanel } from "./ui/MapPanel.tsx"
import { PlotPanels, plotLayout, plotsOf } from "./ui/PlotPanel.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useKeyboard } from "./ui/useKeyboard.ts"
import { useArmKeys } from "./ui/useArmKeys.ts"
import { useGamepad } from "./ui/useGamepad.ts"
import { SteamDeckBanner } from "./ui/SteamDeckBanner.tsx"
import { ArmHud } from "./ui/ArmHud.tsx"
import { useLockedViewport, useMobile } from "./ui/useMobile.ts"
import { StatsOverlay } from "./ui/StatsOverlay.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"
import { ScenePanel } from "./ui/ScenePanel.tsx"
import { SnapshotGallery } from "./ui/SnapshotGallery.tsx"
import { InfoPanels } from "./ui/InfoPanels.tsx"
import { EmptyLayer, useOnboarding } from "./ui/Onboarding.tsx"
import { Overlays } from "./ui/Overlays.tsx"
import { rectStyle, useWorkspace, type WorkspaceApi, WorkspaceContext, WorkspaceSurface } from "./ui/Workspace.tsx"
import { cameraId, FIXED_PANELS, plotId } from "./ui/workspace.ts"
import type { RunState } from "./core/runs.ts"
import { openOverlay } from "./ui/overlay.ts"
import { ContainCrash } from "./ui/Unavailable.tsx"

declare global {
    interface Window {
        __lv?: ViewerApp
    }
}

export function App() {
    const host = useRef<HTMLDivElement>(null)
    const [app, setApp] = useState<ViewerApp | null>(null)
    const mobile = useMobile()
    useLockedViewport(mobile)

    useEffect(() => {
        const created = new ViewerApp(host.current!)
        window.__lv = created
        setApp(created)
        // DimThemeProvider applies Desktop's skin and fires `dimos-react-theme` on every change
        const theme = () => {
            document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim())
            created.viewer.setTheme()
        }
        theme()
        addEventListener("dimos-react-theme", theme)
        return () => removeEventListener("dimos-react-theme", theme)
    }, [])

    const cameras = useStore(cameraLayout)
    const robot = useStore(app?.robot ?? placeholderRobot)
    const runs = useStore(app?.runs.state ?? placeholderRuns)
    const plots = plotsOf(useStore(plotLayout))
    const ids = [...cameras.panels.map((panel) => cameraId(panel.id)), ...FIXED_PANELS, ...plots.map((plot) => plotId(plot.id))]
    const cameraActions = useCameraActions(app)
    const api = useWorkspace(ids, mobile)
    // the profile changes with the robot type: keys follow it
    const profile = app && robot ? app.profile : null
    useKeyboard(profile?.type === "arm" ? null : app?.drive ?? null, profile?.type === "arm" ? null : profile, api, app?.joy ?? null, profile?.joint ? app?.arm ?? null : null)
    useArmKeys(app?.arm ?? null, profile?.type === "arm" ? profile : null)
    useGamepad(app)

    return (
        <WorkspaceContext.Provider value={api}>
            <div className={`app ${mobile ? "mobile" : "desktop"} ${!mobile && api.view.hide.length === 2 ? "focused" : ""}`} onPointerDownCapture={takeKeyboard}>
                {app && mobile && <PhoneCorners app={app} api={api} />}
                <ZoomDebug />
                <div className="workspace">
                    <ContainCrash what="3D view"><ScenePanel host={host} app={app} onTf={() => api.act("tf", "show")} /></ContainCrash>
                    {app && (
                        <>
                            <ContainCrash what="Cameras"><CameraPanels app={app} /></ContainCrash>
                            <ContainCrash what="Map"><MapPanel app={app} /></ContainCrash>
                            <PlotPanels app={app} />
                            <InfoPanels app={app} />
                        </>
                    )}
                    <WorkspaceSurface emptyStage={(noPanels) => <EmptyStage mobile={mobile} noPanels={noPanels} />} />
                </div>
                {app && <Driving app={app} api={api} />}
                {app && <ActionBar api={api} />}
                {app && <GlassWindow app={app} />}
                {app && <Overlays app={app} api={api} cameras={cameraActions} />}
                {app && <StatsOverlay app={app} />}
                <SteamDeckBanner />
                {app && <SceneMenu app={app} />}
                {app && <SettingsDrawer app={app} api={api} />}
                <SnapshotGallery />
            </div>
        </WorkspaceContext.Provider>
    )
}

const placeholderRobot = new Store({ type: "dog" as const, auto: true, reason: "" })
const placeholderRuns = new Store<RunState>({ known: false, desktop: false, dimosInstalled: null, running: [], starting: null, blueprints: {} })

/** Nothing in the main view: "Add a panel", and, with no panels at all, an arrow down to the Settings button that adds one (a phone: its panel list). */
function EmptyStage({ mobile, noPanels }: { mobile: boolean; noPanels: boolean }) {
    if (mobile) {
        return (
            <div className="ws-empty-note">
                <p>The main view is empty.</p>
                <p className="hint">Open a panel from the panel list, or <button type="button" className="link" onClick={() => openOverlay("palette")}>the palette</button>.</p>
            </div>
        )
    }
    return (
        <div className="ws-empty-add" data-testid="empty-stage">
            <button type="button" className="ws-empty-card" onClick={openSettingsDrawer}>
                <b>Add a panel</b>
                <span>Camera, 3D view, map or plot: they're under Settings.</span>
            </button>
            {noPanels && <svg className="ws-empty-arrow" viewBox="0 0 520 330" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
                <defs><marker id="ws-arrow-head" markerWidth="12" markerHeight="12" refX="7" refY="6" orient="auto"><path d="M0 0L12 6 0 12z" /></marker></defs>
                <path d="M40 10 C 220 30, 420 100, 470 300" markerEnd="url(#ws-arrow-head)" />
            </svg>}
        </div>
    )
}

/** The dock (desktop) or the sticks (phone), and, until there's something to drive, the first-run message over the main view. */
function Driving({ app, api }: { app: ViewerApp; api: WorkspaceApi }) {
    const onboarding = useOnboarding(app)
    const isArm = useStore(app.robot).type === "arm"
    return (
        <>
            {api.mobile
                ? !onboarding.blocksDriving && (isArm ? <ArmHud app={app} mobile /> : <DriveHud app={app} mobile />)
                : <><TopBar app={app} api={api} /><KeyOverlay app={app} stage={api.layout.stage} /></>}
            {onboarding.message && (
                <div className="stage-message" style={rectStyle(api.layout.stage)}>
                    <EmptyLayer {...onboarding.message} />
                </div>
            )}
        </>
    )
}

/** A click or tap on the view (not in a field) gives the Controller the keyboard, so WASD drives right away, even inside
 * Desktop's iframe. */
function takeKeyboard(event: PointerEvent) {
    const target = event.target as HTMLElement
    if (target.closest("input, textarea, select, [contenteditable]")) {
        return
    }
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && active.matches("input, textarea, select, [contenteditable]")) {
        active.blur()
    }
    globalThis.focus()
}
