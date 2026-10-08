// The 3D view as a panel: fullscreen behind everything, or (while a camera is main) a picture-in-picture with the
// camera's header bar (drag it, double-click or the expand button for fullscreen), a resize corner, a point cloud menu
// (each PointCloud2 on the bus: on/off, this viewer's bandwidth preset, color and size, live points and bytes a second)
// and an off switch: off, every 3D layer stops (nothing subscribed, no bandwidth) and only a small bar to turn it back
// on is left. View-only: nothing here moves the robot.
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from "react"
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
import { clampPanelBox, startPanelDrag } from "./panelDrag.ts"
import { ViewControls } from "./ViewControls.tsx"
import { TfFootnote } from "./TfFootnote.tsx"

const HEAD_PX = 33
const MIN_WIDTH = 220, MIN_HEIGHT = 150 + HEAD_PX

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

export function ScenePanel({ host, app, mainCamera, mobile, onMain, onTf }: {
    host: RefObject<HTMLDivElement | null>
    app: ViewerApp | null
    /** a camera fills the screen: this is the picture-in-picture */
    mainCamera: boolean
    mobile: boolean
    /** make the 3D view fullscreen again */
    onMain: () => void
    onTf: () => void
}) {
    const state = useStore(scenePanel)
    const off = state.off
    const element = useRef<HTMLDivElement>(null)
    const [menuOpen, setMenuOpen] = useState(false)

    // off is per viewer and survives a reload: the layers stay stopped from the start
    useEffect(() => {
        app?.layers.setPaused(off)
        if (off) {
            setMenuOpen(false)
        }
    }, [app, off])

    const floating = mainCamera
    const startDrag = (event: ReactPointerEvent) => {
        if (!floating || mobile || (event.target as HTMLElement).closest("button, select, input, label")) {
            return
        }
        startPanelDrag(event, element.current!, (x, y) => updateScenePanel({ x, y }))
    }

    // the handle on the corner facing into the screen (bottom-left while it sits on the right half: the default)
    const handleLeft = state.x < 0 || state.x + Math.max(state.width, MIN_WIDTH) / 2 > (globalThis.innerWidth || 1280) / 2
    const startResize = (event: ReactPointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        const panel = element.current!
        const box = panel.getBoundingClientRect()
        const startX = event.clientX, startY = event.clientY
        const handle = event.currentTarget as HTMLElement
        handle.setPointerCapture(event.pointerId)
        let width = box.width, height = box.height, left = box.left
        // from here on it's placed by its top-left corner, so the far edges stay put while it grows
        Object.assign(panel.style, { left: `${box.left}px`, top: `${box.top}px`, right: "auto", bottom: "auto" })
        const move = (moved: PointerEvent) => {
            const grown = handleLeft ? startX - moved.clientX : moved.clientX - startX
            width = Math.round(Math.max(MIN_WIDTH, Math.min(handleLeft ? box.right - 8 : innerWidth - box.left - 8, box.width + grown)))
            height = Math.round(Math.max(MIN_HEIGHT, Math.min(innerHeight - box.top - 8, box.height + moved.clientY - startY)))
            left = handleLeft ? box.right - width : box.left
            Object.assign(panel.style, { width: `${width}px`, height: `${height}px`, left: `${left}px` })
        }
        const up = () => {
            handle.removeEventListener("pointermove", move)
            handle.removeEventListener("pointerup", up)
            handle.removeEventListener("pointercancel", up)
            updateScenePanel({ width, height, x: left, y: box.top })
        }
        handle.addEventListener("pointermove", move)
        handle.addEventListener("pointerup", up)
        handle.addEventListener("pointercancel", up)
    }

    // the remembered box made safe for this window (a smaller screen, a bad saved value); unset = the CSS corner and size
    const box = clampPanelBox({ ...state, width: state.width > 0 ? state.width : undefined, height: state.height > 0 ? state.height : undefined }, { x: -1, y: -1, width: MIN_WIDTH, height: MIN_HEIGHT }, { width: globalThis.innerWidth, height: globalThis.innerHeight }, { width: MIN_WIDTH, height: MIN_HEIGHT })
    const placed: React.CSSProperties = box.x >= 0 ? { left: box.x, top: box.y, right: "auto", bottom: "auto" } : {}
    const sized: React.CSSProperties = state.width > 0 && !off ? { width: box.width, height: box.height } : {}
    const style = floating && !mobile ? { ...placed, ...sized } : {}
    const setOff = (next: boolean) => updateScenePanel({ off: next })

    return (
        <div ref={element} className={`scene-slot ${floating ? "floating" : ""} ${off ? "off" : ""}`} style={style} data-testid="scene-panel">
            {floating && (
                <div className="camera-head scene-head" onPointerDown={startDrag} onDoubleClick={off ? undefined : onMain}>
                    <span className="map-title"><Icon name="cube" size={14} />3D</span>
                    {app && !off && <SceneRate />}
                    {off && <span className="camera-info scene-off-note">off · nothing subscribed</span>}
                    {app && !off && <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} />}
                    {!off && <button type="button" className="dim-btn icon icon-button" title="Fullscreen 3D view (the camera becomes a popup)" aria-label="Fullscreen 3D view" onClick={onMain}><Icon name="expand" size={15} /></button>}
                    <PowerButton off={off} onChange={setOff} />
                </div>
            )}
            <div ref={host} className="scene" />
            {app && !floating && !off && <ViewControls app={app} />}
            {app && !floating && !off && <TfFootnote app={app} onOpen={onTf} />}
            {app && !floating && !off && (
                <div className="scene-tools dim-panel">
                    <SceneRate />
                    <CloudButton app={app} open={menuOpen} onOpen={setMenuOpen} />
                    <PowerButton off={off} onChange={setOff} />
                </div>
            )}
            {!floating && off && (
                <div className="dim-panel scene-off">
                    <Icon name="cube" size={15} />
                    <span>3D view off · nothing subscribed</span>
                    <PowerButton off={off} onChange={setOff} />
                </div>
            )}
            {floating && !off && !mobile && (
                <div className={`camera-resize ${handleLeft ? "left" : "right"}`} title="Drag to resize" aria-label="Resize the 3D view" onPointerDown={startResize} />
            )}
            {app && menuOpen && !off && <CloudMenu app={app} anchor={element.current} onClose={() => setMenuOpen(false)} />}
        </div>
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

function CloudButton({ app, open, onOpen }: { app: ViewerApp; open: boolean; onOpen: (open: boolean) => void }) {
    const { list } = useStore(app.layers.entries)
    const clouds = list.filter(isCloud)
    const on = clouds.filter((entry) => entry.enabled).length
    return (
        <button type="button" className="dim-btn icon icon-button scene-clouds" aria-haspopup="menu" aria-expanded={open} title={`Point clouds: ${on} of ${clouds.length} shown`} aria-label="Point clouds" onClick={() => onOpen(!open)}>
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
        <div className="dim-panel cloud-menu" role="menu" aria-label="Point clouds" style={menuPosition(anchor)}>
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

/** The menu hangs from the panel's top-right corner (its bottom-right, fullscreen), kept inside the window. */
function menuPosition(panel: HTMLElement | null): React.CSSProperties {
    const width = 320
    const box = panel?.getBoundingClientRect()
    if (!box || box.width >= innerWidth - 4) {
        return { position: "fixed", right: 60, bottom: 112, width, zIndex: 40 }
    }
    const left = Math.max(8, Math.min(box.right - width, innerWidth - width - 8))
    const top = Math.max(56, Math.min(box.top + HEAD_PX + 4, innerHeight - 320))
    return { position: "fixed", left, top, width, zIndex: 40 }
}
