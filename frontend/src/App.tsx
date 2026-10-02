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
import { followNewTopics } from "./ui/RecorderPanel.tsx"

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
        followNewTopics(created)
        window.__lv = created
        setApp(created)
        // dark unless Settings says light (or system and the system is light)
        const media = matchMedia("(prefers-color-scheme: light)")
        const theme = () => {
            const choice = created.settings.get().theme ?? "dark"
            const dark = choice === "dark" || (choice === "system" && !media.matches)
            document.body.classList.toggle("dark", dark)
            document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#06090f" : "#f4f6f8")
            created.viewer.setTheme(dark)
        }
        theme()
        media.addEventListener("change", theme)
        const stop = created.settings.subscribe(theme)
        return () => {
            media.removeEventListener("change", theme)
            stop()
        }
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
                    <button type="button" className="pip-expand" title="Make the 3D view fullscreen" onClick={() => cameraLayout.update({ main: null })}>⤢</button>
                )}
            </div>
            {app && (
                <>
                    <TopBar app={app} tab={tab} onTab={(next) => setTab(tab === next ? null : next)} />
                    {tab && <SidePanel app={app} tab={tab} onTab={setTab} onClose={() => setTab(null)} mobile={view.mobile} />}
                    <CameraPanels app={app} layout={cameraLayout} mobile={view.mobile} />
                    <DriveHud app={app} mobile={view.mobile} />
                    <StatsOverlay app={app} />
                </>
            )}
        </div>
    )
}
