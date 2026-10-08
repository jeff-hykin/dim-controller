// The panel the top bar's tabs open. Where it goes depends on the layout (ui/layout.ts): beside the view on the left
// (Classic), a drawer sliding over from the right (Cockpit, Tiles), a column the layout makes room for (Split), or a
// bottom sheet on a phone.
import type { CSSProperties } from "react"
import type { ViewerApp } from "../core/app.ts"
import { Icon } from "./icons.tsx"
import { LayersPanel } from "./LayersPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"
import type { Rect } from "./layout.ts"

export type Tab = "layers" | "tf" | "settings"
export type SidePlacement = "side" | "drawer" | "column" | "sheet"

const TITLES: Record<Tab, string> = { layers: "Layers", tf: "Transforms", settings: "Settings" }

export function SidePanel({ app, tab, onClose, placement, rect }: { app: ViewerApp; tab: Tab; onClose: () => void; placement: SidePlacement; rect?: Rect | null }) {
    const style: CSSProperties = placement === "column" && rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}
    return (
        <aside className={`dim-panel glass side-panel ${placement}`} style={style} data-tab={tab}>
            <div className="panel-head">
                <h2 className="dim-card-title">{TITLES[tab]}</h2>
                <button type="button" className="dim-btn icon icon-button" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
            </div>
            <div className="panel-body">
                {tab === "layers" && <LayersPanel app={app} />}
                {tab === "tf" && <TfPanel app={app} />}
                {tab === "settings" && <SettingsPanel app={app} />}
            </div>
        </aside>
    )
}
