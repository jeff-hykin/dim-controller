// The page: the 3D view (or a camera) fills the screen; panels float over it. On a phone the panels become a
// bottom sheet and driving moves to on-screen sticks.
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react"
import { ViewerApp } from "./core/app.ts"
import { persistentStore, Store, useStore } from "./core/store.ts"
import { TopBar } from "./ui/TopBar.tsx"
import { RecordControl } from "./ui/RecordControl.tsx"
import { SidePanel, type Tab } from "./ui/SidePanel.tsx"
import { CameraPanels, chooseLayout, type CameraLayout } from "./ui/CameraPanels.tsx"
import { MapPanel } from "./ui/MapPanel.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useDriveKeys } from "./ui/useDriveKeys.ts"
import { useArmKeys } from "./ui/useArmKeys.ts"
import { ArmHud } from "./ui/ArmHud.tsx"
import { useLockedViewport, useMobile } from "./ui/useMobile.ts"
import { StatsOverlay } from "./ui/StatsOverlay.tsx"
import { Icon } from "./ui/icons.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"
import { ViewControls } from "./ui/ViewControls.tsx"
import { TfFootnote } from "./ui/TfFootnote.tsx"
import { EmptyLayer, useOnboarding } from "./ui/Onboarding.tsx"

const noRobot = new Store({ type: "dog" as const, auto: true, reason: "" })
const cameraLayout = persistentStore<CameraLayout>("lv.cameras", { panels: [], main: null })

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
    // no panel open at first: the 3D view gets the whole screen, and the Record button the top-left corner
    const [tab, setTab] = useState<Tab | null>(null)

    useEffect(() => {
        const created = new ViewerApp(host.current!)
        window.__lv = created
        setApp(created)
        // theme.js picks Portal (dark) / Research (light), sets body.dark and fires `dim-theme`
        const theme = () => {
            const dark = document.body.classList.contains("dark")
            document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).getPropertyValue("--bg").trim())
            created.viewer.setTheme(dark)
        }
        theme()
        addEventListener("dim-theme", theme)
        return () => removeEventListener("dim-theme", theme)
    }, [])

    const layout = useStore(cameraLayout)
    const mainCamera = layout.main !== null && layout.panels.some((panel) => panel.id === layout.main)
    const robot = useStore(app?.robot ?? noRobot)
    // the profile changes with the robot type: keys follow it
    const profile = app && robot ? app.profile : null
    useDriveKeys(app?.drive ?? null, profile)
    useArmKeys(app?.arm ?? null, profile?.type === "arm" ? profile : null)

    const view = useMemo(() => ({ mobile, mainCamera }), [mobile, mainCamera])

    return (
        <div className={`app ${view.mobile ? "mobile" : "desktop"} ${view.mainCamera ? "camera-main" : "scene-main"}`} onPointerDownCapture={takeKeyboard}>
            <div className="scene-slot">
                <div ref={host} className="scene" />
                {app && !view.mainCamera && <ViewControls app={app} />}
                {app && !view.mainCamera && <TfFootnote app={app} onOpen={() => setTab("tf")} />}
                {view.mainCamera && (
                    <button type="button" className="dim-btn round pip-expand" title="Make the 3D view fullscreen" aria-label="Make the 3D view fullscreen" onClick={() => {
                        chooseLayout()
                        cameraLayout.update({ main: null, auto: false, autoPanel: null })
                    }}><Icon name="expand" size={15} /></button>
                )}
            </div>
            {app && (
                <>
                    <TopBar app={app} tab={tab} onTab={(next) => setTab(tab === next ? null : next)} />
                    <RecordControl app={app} />
                    {tab && <SidePanel app={app} tab={tab} onTab={setTab} onClose={() => setTab(null)} mobile={view.mobile} />}
                    <CameraPanels app={app} layout={cameraLayout} mobile={view.mobile} />
                    <MapPanel app={app} mobile={view.mobile} />
                    <FirstRun app={app} mobile={view.mobile} />
                    <StatsOverlay app={app} />
                    <SceneMenu app={app} />
                </>
            )}
        </div>
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

/** The drive bar, or (until there's something to drive) the first-run message that says what's missing. */
function FirstRun({ app, mobile }: { app: ViewerApp; mobile: boolean }) {
    const onboarding = useOnboarding(app)
    const isArm = useStore(app.robot).type === "arm"
    return (
        <>
            {!onboarding.blocksDriving && (isArm ? <ArmHud app={app} mobile={mobile} /> : <DriveHud app={app} mobile={mobile} />)}
            {onboarding.message && <EmptyLayer {...onboarding.message} />}
        </>
    )
}
