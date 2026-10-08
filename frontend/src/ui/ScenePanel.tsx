// The 3D view as a panel (ui/Panel.tsx): Classic's full window behind everything, or (while a camera is main) a
// picture-in-picture with a header (drag it, double-click or the expand button for fullscreen) and a resize corner, or
// a layout's docked region. Its header has a point cloud menu (each PointCloud2 on the bus: on/off, this viewer's
// bandwidth preset, color and size, live points and bytes a second) and an off switch: off, every 3D layer stops
// (nothing subscribed, no bandwidth) and only a small bar to turn it back on is left. View-only: nothing here moves the
// robot. The element the viewer draws into (`host`) is never remounted: only the panel's placement changes.
import { type RefObject, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { type Store, useStore } from "../core/store.ts"
import { CLOUD_PRESETS, cloudQualities, cloudQualityOf, type CloudQuality, type CloudRate, cloudRates, formatBytes, formatCount, scenePanel, setCloudQuality, updateScenePanel } from "../core/cloudQuality.ts"
import { GRADIENTS } from "../core/render/gradients.ts"
import type { PointLook } from "../core/render/pointMaterial.ts"
import type { CloudSettings } from "../layers/pointcloud.tsx"
import { Icon } from "./icons.tsx"
import { Toggle } from "./controls.tsx"
import { clampPanelBox, PANEL_HEAD_PX, popoverPosition } from "./panelDrag.ts"
import { type Dock, Panel, type Placement } from "./Panel.tsx"
import { ViewControls } from "./ViewControls.tsx"
import { TfFootnote } from "./TfFootnote.tsx"

const MIN_WIDTH = 220, MIN_HEIGHT = 150 + PANEL_HEAD_PX

const COLOR_MODES: [PointLook["colorMode"], string][] = [["height", "by height"], ["intensity", "by intensity"], ["range", "by distance"], ["solid", "solid"]]

const isCloud = (entry: LayerEntry) => entry.topic.type === "sensor_msgs.PointCloud2"

/** The sum over the clouds being drawn. */
export function totalRate(rates: Record<string, CloudRate>): CloudRate & { clouds: number } {
    const all = Object.values(rates)
    return {
        clouds: all.length,
        hz: 0,
        pointsPerSecond: all.reduce((sum, rate) => sum + rate.pointsPerSecond, 0),
        bytesPerSecond: all.reduce((sum, rate) => sum + rate.bytesPerSecond, 0),
    }
}

export function ScenePanel({ host, app, placement, dock, mobile, onMain, onTf }: {
    host: RefObject<HTMLDivElement | null>
    app: ViewerApp | null
    /** "main": Classic's full window; "float": the picture-in-picture while a camera is main; "dock": a layout's region */
    placement: Placement
    dock: Dock | null
    mobile: boolean
    /** Classic: make the 3D view fullscreen again */
    onMain: () => void
    onTf: () => void
}) {
    const state = useStore(scenePanel)
    const off = state.off
    const [menuOpen, setMenuOpen] = useState(false)
    const cloudButton = useRef<HTMLButtonElement>(null)

    // off is per viewer and survives a reload: the layers stay stopped from the start
    useEffect(() => {
        app?.layers.setPaused(off)
        if (off) {
            setMenuOpen(false)
        }
    }, [app, off])

    const floating = placement === "float"
    // the handle on the corner facing into the screen (bottom-left while it sits on the right half: the default)
    const handleLeft = state.x < 0 || state.x + Math.max(state.width, MIN_WIDTH) / 2 > (globalThis.innerWidth || 1280) / 2
    // the remembered box made safe for this window (a smaller screen, a bad saved value); unset = the CSS corner and size
    const box = clampPanelBox({ ...state, width: state.width > 0 ? state.width : undefined, height: state.height > 0 ? state.height : undefined }, { x: -1, y: -1, width: MIN_WIDTH, height: MIN_HEIGHT }, { width: globalThis.innerWidth, height: globalThis.innerHeight }, { width: MIN_WIDTH, height: MIN_HEIGHT })
    const placed: React.CSSProperties = box.x >= 0 ? { left: box.x, top: box.y, right: "auto", bottom: "auto" } : {}
    const sized: React.CSSProperties = state.width > 0 && !off ? { width: box.width, height: box.height } : {}
    const style = floating && !mobile ? { ...placed, ...sized } : {}
    const setOff = (next: boolean) => updateScenePanel({ off: next })
    // a header (float, dock) carries the tools; the full window has them over its corner instead
    const headed = placement !== "main"

    return (
        <Panel
            placement={placement}
            dock={dock}
            className={`scene-slot ${off ? "off" : ""}`}
            style={style}
            testid="scene-panel"
            onHeadDoubleClick={off ? undefined : onMain}
            onDrag={floating && !mobile ? (x, y) => updateScenePanel({ x, y }) : undefined}
            resize={floating && !off && !mobile ? { corner: handleLeft ? "left" : "right", minimum: { width: MIN_WIDTH, height: MIN_HEIGHT }, onDone: (next) => updateScenePanel(next) } : null}
            head={headed && (
                <>
                    <span className="map-title"><Icon name="cube" size={14} />3D</span>
                    {app && !off && <SceneRate />}
                    {off && <span className="camera-info scene-off-note">off · nothing subscribed</span>}
                    {app && !off && <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} buttonRef={cloudButton} />}
                    {floating && !off && <button type="button" className="dim-btn icon icon-button" title="Fullscreen 3D view (the camera becomes a popup)" aria-label="Fullscreen 3D view" onClick={onMain}><Icon name="expand" size={15} /></button>}
                    <PowerButton off={off} onChange={setOff} />
                </>
            )}
        >
            <div ref={host} className="scene" />
            {app && !off && placement !== "float" && <ViewControls app={app} />}
            {app && !off && placement !== "float" && <TfFootnote app={app} onOpen={onTf} />}
            {app && !headed && !off && (
                <div className="scene-tools dim-panel">
                    <SceneRate />
                    <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} buttonRef={cloudButton} />
                    <PowerButton off={off} onChange={setOff} />
                </div>
            )}
            {off && !headed && (
                <div className="dim-panel scene-off">
                    <Icon name="cube" size={15} />
                    <span>3D view off · nothing subscribed</span>
                    <PowerButton off={off} onChange={setOff} />
                </div>
            )}
            {app && menuOpen && !off && <CloudMenu app={app} anchor={cloudButton.current} onClose={() => setMenuOpen(false)} />}
        </Panel>
    )
}

function PowerButton({ off, onChange }: { off: boolean; onChange: (off: boolean) => void }) {
    const title = off ? "Turn the 3D view on (subscribes to its layers again)" : "Turn the 3D view off (unsubscribes every 3D layer: no bandwidth)"
    return (
        <button type="button" className={`dim-btn icon icon-button scene-power ${off ? "" : "on"}`} aria-pressed={!off} title={title} aria-label={off ? "Turn the 3D view on" : "Turn the 3D view off"} onClick={() => onChange(!off)}>
            <Icon name="power" size={15} />
        </button>
    )
}

function SceneRate() {
    const total = totalRate(useStore(cloudRates))
    const text = total.clouds ? `${formatCount(total.pointsPerSecond)} pts/s · ${formatBytes(total.bytesPerSecond)}/s` : "no cloud"
    return <span className="camera-info scene-rate" title={`${total.clouds} point cloud${total.clouds === 1 ? "" : "s"} drawn: points and bytes received a second`}>{text}</span>
}

function CloudButton({ app, open, onOpen, buttonRef }: { app: ViewerApp; open: boolean; onOpen: (open: boolean) => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
    const { list } = useStore(app.layers.entries)
    const clouds = list.filter(isCloud)
    const on = clouds.filter((entry) => entry.enabled).length
    return (
        <button ref={buttonRef} type="button" className="dim-btn icon icon-button scene-clouds" aria-haspopup="menu" aria-expanded={open} title={`Point clouds: ${on} of ${clouds.length} shown`} aria-label="Point clouds" onClick={() => onOpen(!open)}>
            <Icon name="layers" size={15} />
            {clouds.length > 0 && <span className="scene-count">{on}/{clouds.length}</span>}
        </button>
    )
}

function CloudMenu({ app, anchor, onClose }: { app: ViewerApp; anchor: HTMLElement | null; onClose: () => void }) {
    const { list } = useStore(app.layers.entries)
    const rates = useStore(cloudRates)
    useStore(cloudQualities)
    const clouds = list.filter(isCloud)
    useEffect(() => {
        const close = (event: Event) => {
            if (!(event.target as HTMLElement).closest?.(".cloud-menu, .scene-clouds")) {
                onClose()
            }
        }
        addEventListener("pointerdown", close, true)
        return () => removeEventListener("pointerdown", close, true)
    }, [onClose])
    return createPortal(
        <div className="dim-panel cloud-menu" role="menu" aria-label="Point clouds" style={popoverPosition(anchor, 320)}>
            <div className="quality-title">Point clouds</div>
            {!clouds.length && <p className="cloud-empty">No PointCloud2 on the bus yet.</p>}
            {clouds.map((entry) => <CloudRow key={entry.topic.key} app={app} entry={entry} rate={rates[entry.topic.key]} />)}
        </div>,
        document.body,
    )
}

function CloudRow({ app, entry, rate }: { app: ViewerApp; entry: LayerEntry; rate: CloudRate | undefined }) {
    const settings = entry.settings as Store<CloudSettings>
    const { look } = useStore(settings)
    const quality = cloudQualityOf(entry.topic.key)
    const setLook = (patch: Partial<PointLook>) => settings.update({ look: { ...look, ...patch } })
    const preset = CLOUD_PRESETS.find((other) => other.id === quality)!
    return (
        <div className={`cloud-row ${entry.enabled ? "on" : ""}`} data-key={entry.topic.key}>
            <div className="cloud-line">
                <Toggle value={entry.enabled} onChange={(enabled) => app.layers.setEnabled(entry.topic.key, enabled)} />
                <span className="cloud-name" title={entry.topic.key}>{entry.topic.name}</span>
                <span className="cloud-rate">{entry.enabled && rate ? `${formatCount(rate.pointsPerSecond)} pts/s · ${formatBytes(rate.bytesPerSecond)}/s` : entry.enabled ? "…" : "off"}</span>
            </div>
            {entry.enabled && (
                <div className="cloud-controls">
                    <div className="cloud-presets" role="radiogroup" aria-label={`${entry.topic.name} bandwidth`} title={preset.about}>
                        {CLOUD_PRESETS.map((option) => (
                            <button key={option.id} type="button" role="radio" aria-checked={quality === option.id} className={`cloud-preset ${quality === option.id ? "on" : ""}`} title={option.about} onClick={() => setCloudQuality(entry.topic.key, option.id as CloudQuality)}>
                                {option.id === "low" ? "Low" : option.label}
                            </button>
                        ))}
                    </div>
                    <select className="dim-select cloud-color" value={look.colorMode} aria-label={`${entry.topic.name} color by`} onChange={(event) => setLook({ colorMode: event.target.value as PointLook["colorMode"] })}>
                        {COLOR_MODES.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
                    </select>
                    {look.colorMode === "solid"
                        ? <input type="color" className="cloud-solid" value={look.solid} aria-label={`${entry.topic.name} solid color`} onChange={(event) => setLook({ solid: event.target.value })} />
                        : (
                            <select className="dim-select cloud-color" value={look.gradient} aria-label={`${entry.topic.name} colormap`} onChange={(event) => setLook({ gradient: event.target.value })}>
                                {GRADIENTS.map((gradient) => <option key={gradient} value={gradient}>{gradient}</option>)}
                            </select>
                        )}
                    <label className="cloud-size" title="point size">
                        <input type="range" className="dim-range" min={0.01} max={0.5} step={0.01} value={look.size} aria-label={`${entry.topic.name} point size`} onChange={(event) => setLook({ size: Number(event.target.value) })} />
                        <span>{Math.round(look.size * 100)} cm</span>
                    </label>
                </div>
            )}
        </div>
    )
}
