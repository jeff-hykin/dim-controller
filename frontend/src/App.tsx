// The page, in the layout picked in Settings (ui/layout.ts). Classic: the 3D view (or a camera) fills the screen and
// panels float over it. Cockpit, Split and Tiles: each region (camera, 3D view, map, drive, status, settings) docked in
// the box the layout gives it. On a phone the side panels become a bottom sheet and driving moves to on-screen sticks,
// whatever the layout.
import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { ViewerApp } from "./core/app.ts"
import { persistentStore, Store, useStore } from "./core/store.ts"
import { TopBar } from "./ui/TopBar.tsx"
import { RecordControl } from "./ui/RecordControl.tsx"
import { type SidePlacement, SidePanel, type Tab } from "./ui/SidePanel.tsx"
import { CameraPanels, chooseLayout, type CameraLayout } from "./ui/CameraPanels.tsx"
import { MapPanel } from "./ui/MapPanel.tsx"
import { SimPanel } from "./ui/SimPanel.tsx"
import { DriveHud } from "./ui/DriveHud.tsx"
import { useDriveKeys } from "./ui/useDriveKeys.ts"
import { useArmKeys } from "./ui/useArmKeys.ts"
import { ArmHud } from "./ui/ArmHud.tsx"
import { useLockedViewport, useMobile } from "./ui/useMobile.ts"
import { StatsOverlay } from "./ui/StatsOverlay.tsx"
import { SceneMenu } from "./ui/SceneMenu.tsx"
import { ScenePanel } from "./ui/ScenePanel.tsx"
import { EmptyLayer, useOnboarding } from "./ui/Onboarding.tsx"
import { type Frame, layoutSettings, maximized, type Rect, type Region, regionRects, stickHeight, toggleMaximized, useLayout } from "./ui/layout.ts"
import { type Dock, Panel } from "./ui/Panel.tsx"
import { StatusPanel } from "./ui/StatusPanel.tsx"
import { SettingsPanel } from "./ui/SettingsPanel.tsx"
import { Icon } from "./ui/icons.tsx"

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

    const cameras = useStore(cameraLayout)
    const robot = useStore(app?.robot ?? noRobot)
    // the profile changes with the robot type: keys follow it
    const profile = app && robot ? app.profile : null
    useDriveKeys(app?.drive ?? null, profile)
    useArmKeys(app?.arm ?? null, profile?.type === "arm" ? profile : null)

    const layout = useLayout()
    const classic = layout.mode === "classic"
    const { region: maximizedRegion } = useStore(maximized)
    useEscapeRestores()
    // Tiles (desktop) has Settings as a tile: its tab maximizes that tile instead of opening a panel
    const settingsTile = layout.mode === "tiles" && !mobile
    const sideTab = settingsTile && tab === "settings" ? null : tab
    const frame = useFrame(mobile, layout.mode === "split" && sideTab !== null)
    const rects = regionRects(layout.mode, frame, layout.tiles, maximizedRegion)
    const dock = (region: Region): Dock | null => classic ? null : {
        region,
        rect: rects[region] ?? null,
        maximized: maximizedRegion === region,
        onMaximize: () => toggleMaximized(region),
        tiles: layout.mode === "tiles" ? { order: layout.tiles, onOrder: (tiles) => layoutSettings.update({ tiles }) } : undefined,
    }
    // Classic only: a camera can take the screen (the 3D view becomes its picture-in-picture)
    const mainCamera = classic && cameras.main !== null && cameras.panels.some((panel) => panel.id === cameras.main)
    const sidePlacement: SidePlacement = mobile ? "sheet" : classic ? "side" : layout.mode === "split" ? "column" : "drawer"
    const onTab = (next: Tab) => {
        if (settingsTile && next === "settings") {
            toggleMaximized("settings")
            return
        }
        setTab(tab === next ? null : next)
    }
    const shownTab = settingsTile && maximizedRegion === "settings" ? "settings" : sideTab
    // into Tiles with Settings open: it's a tile now, so the tab closes (and doesn't come back on leaving Tiles)
    useEffect(() => {
        if (settingsTile) {
            setTab((open) => open === "settings" ? null : open)
        }
    }, [settingsTile])

    return (
        <div className={`app ${mobile ? "mobile" : "desktop"} layout-${layout.mode} ${classic ? (mainCamera ? "camera-main" : "scene-main") : "docked"}`} onPointerDownCapture={takeKeyboard}>
            <ScenePanel host={host} app={app} placement={classic ? (mainCamera ? "float" : "main") : "dock"} dock={dock("scene")} mobile={mobile} onTf={() => setTab("tf")} onMain={() => {
                chooseLayout()
                cameraLayout.update({ main: null, auto: false, autoPanel: null })
            }} />
            {app && (
                <>
                    <TopBar app={app} tab={shownTab} onTab={onTab} />
                    <RecordControl app={app} />
                    {sideTab && <SidePanel app={app} tab={sideTab} onClose={() => setTab(null)} placement={sidePlacement} rect={rects.settings} />}
                    <CameraPanels app={app} layout={cameraLayout} mobile={mobile} dock={dock("camera")} />
                    <MapPanel app={app} mobile={mobile} dock={dock("map")} />
                    <SimPanel app={app} mobile={mobile} />
                    {settingsTile && (
                        <Panel placement="dock" dock={dock("settings")} className="settings-tile" head={<span className="map-title"><Icon name="settings" size={14} />Settings</span>} bodyClassName="panel-body">
                            <SettingsPanel app={app} />
                        </Panel>
                    )}
                    {layout.mode === "tiles" && (
                        <Panel placement="dock" dock={dock("status")} className="status-tile" head={<span className="map-title"><Icon name="signal" size={14} />Status</span>} bodyClassName="panel-body">
                            <StatusPanel app={app} />
                        </Panel>
                    )}
                    <FirstRun app={app} mobile={mobile} dock={classic || mobile ? null : dock("drive")} tile={layout.mode === "tiles"} />
                    <StatsOverlay app={app} />
                    <SceneMenu app={app} />
                </>
            )}
        </div>
    )
}

/** Escape gives a maximized region back to the layout (not while typing). */
function useEscapeRestores() {
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (event.key === "Escape" && maximized.get().region && !(event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) {
                maximized.set({ region: null })
            }
        }
        addEventListener("keydown", key)
        return () => removeEventListener("keydown", key)
    }, [])
}

/** The window as the layout sees it (ui/layout.ts Frame), measured again on a resize or a change of Desktop's dock. */
function useFrame(mobile: boolean, sidePanel: boolean): Frame {
    const [, setTick] = useState(0)
    useEffect(() => {
        const again = () => setTick((tick) => tick + 1)
        addEventListener("resize", again)
        // theme.js sets --dim-inset-* on <html> when Desktop's dock moves
        const insets = new MutationObserver(again)
        insets.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] })
        // the top bar appears once the app is up, and grows with a safe-area inset
        const bar = new ResizeObserver(again)
        const watchBar = () => {
            const element = document.querySelector(".topbar")
            if (element) {
                bar.observe(element)
            }
            return !!element
        }
        const timer = watchBar() ? 0 : setInterval(() => watchBar() && clearInterval(timer), 200)
        return () => {
            removeEventListener("resize", again)
            insets.disconnect()
            bar.disconnect()
            clearInterval(timer)
        }
    }, [])
    const root = getComputedStyle(document.documentElement)
    const px = (name: string, fallback: number) => {
        const value = parseFloat(root.getPropertyValue(name))
        return Number.isFinite(value) ? value : fallback
    }
    const width = innerWidth, height = innerHeight
    return {
        width,
        height,
        top: document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? (mobile ? 44 : 48),
        bottom: px("--dim-inset-bottom", 0),
        mobile,
        sticks: mobile ? stickHeight(width, height) : 0,
        sidePanel,
        gap: px("--lv-gap", 8),
    }
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

/** The drive keys (or a phone's sticks), or (until there's something to drive) the first-run message that says what's
 * missing. A docked layout gives the keys a place (`dock`): a tile in Tiles, else a plain box (Split's rail, the
 * Cockpit's bottom middle); without one (Classic, a phone, another region maximized) they keep their own corner. */
function FirstRun({ app, mobile, dock, tile }: { app: ViewerApp; mobile: boolean; dock: Dock | null; tile: boolean }) {
    const onboarding = useOnboarding(app)
    const isArm = useStore(app.robot).type === "arm"
    const hud = onboarding.blocksDriving ? null : isArm ? <ArmHud app={app} mobile={mobile} /> : <DriveHud app={app} mobile={mobile} />
    let placed: ReactNode = hud
    if (dock?.rect && tile) {
        placed = (
            <Panel placement="dock" dock={dock} className="drive-tile" head={<span className="map-title"><Icon name="drive" size={14} />Drive</span>} bodyClassName="drive-region-body">
                {hud ?? <p className="hint">Nothing to drive yet.</p>}
            </Panel>
        )
    } else if (dock?.rect && hud) {
        placed = <div className="drive-region" style={rectStyle(dock.rect)}>{hud}</div>
    }
    return (
        <>
            {placed}
            {onboarding.message && <EmptyLayer {...onboarding.message} />}
        </>
    )
}

const rectStyle = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
