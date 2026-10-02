// The panel the top bar's tabs open: a side panel on a desktop, a bottom sheet on a phone.
import type { ViewerApp } from "../core/app.ts"
import { Icon } from "./icons.tsx"
import { LayersPanel } from "./LayersPanel.tsx"
import { DrivePanel } from "./DrivePanel.tsx"
import { RecorderPanel } from "./RecorderPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"

export type Tab = "layers" | "drive" | "record" | "tf" | "settings"

const TITLES: Record<Tab, string> = { layers: "Layers", drive: "Drive", record: "Record", tf: "Transforms", settings: "Settings" }

export function SidePanel({ app, tab, onClose, mobile }: { app: ViewerApp; tab: Tab; onTab: (tab: Tab) => void; onClose: () => void; mobile: boolean }) {
    return (
        <aside className={`side-panel ${mobile ? "sheet" : ""}`} data-tab={tab}>
            <div className="panel-head">
                <h2>{TITLES[tab]}</h2>
                <button type="button" className="icon-button" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
            </div>
            <div className="panel-body">
                {tab === "layers" && <LayersPanel app={app} />}
                {tab === "drive" && <DrivePanel app={app} />}
                {tab === "record" && <RecorderPanel app={app} />}
                {tab === "tf" && <TfPanel app={app} />}
                {tab === "settings" && <SettingsPanel app={app} />}
            </div>
        </aside>
    )
}
