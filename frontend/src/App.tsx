// The page: the 3D view (or a camera) fills the screen; panels float over it. On a phone the panels become a
// bottom sheet and driving moves to on-screen sticks.
import { useEffect, useMemo, useRef, useState } from "react"
import { ViewerApp } from "./core/app.ts"
import { persistentStore, useStore } from "./core/store.ts"
import { TopBar } from "./ui/TopBar.tsx"
import { SidePanel, type Tab } from "./ui/SidePanel.tsx"
import { CameraPanels, type CameraLayout } from "./ui/CameraPanels.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useDriveKeys } from "./ui/useDriveKeys.ts"
import { useMobile } from "./ui/useMobile.ts"
import { StatsOverlay } from "./ui/StatsOverlay.tsx"
import { Icon } from "./ui/icons.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"

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
    const [tab, setTab] = useState<Tab | null>(() => (matchMedia("(max-width: 720px)").matches ? null : "layers"))

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
    useDriveKeys(app?.drive ?? null, app?.profile ?? null)

    const view = useMemo(() => ({ mobile, mainCamera }), [mobile, mainCamera])

    return (
        <div className={`app ${view.mobile ? "mobile" : "desktop"} ${view.mainCamera ? "camera-main" : "scene-main"}`}>
            <div className="scene-slot">
                <div ref={host} className="scene" />
                {view.mainCamera && (
                    <button type="button" className="dim-btn round pip-expand" title="Make the 3D view fullscreen" aria-label="Make the 3D view fullscreen" onClick={() => cameraLayout.update({ main: null })}><Icon name="expand" size={15} /></button>
                )}
            </div>
            {app && (
                <>
                    <TopBar app={app} tab={tab} onTab={(next) => setTab(tab === next ? null : next)} />
                    {tab && <SidePanel app={app} tab={tab} onTab={setTab} onClose={() => setTab(null)} mobile={view.mobile} />}
                    <CameraPanels app={app} layout={cameraLayout} mobile={view.mobile} />
                    <DriveHud app={app} mobile={view.mobile} />
                    <StatsOverlay app={app} />
                    <SceneMenu app={app} />
                </>
            )}
        </div>
    )
}
