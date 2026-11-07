// What shows while the rest of the page (the 3D view, the panels: App.tsx and three.js, their own chunk) loads: the bar's
// STOP and link, the disengaged banner, and the keys already driving through the drive core (core/driveCore.ts).
import { Button, Kbd } from "dimos-react"
import type { DriveCore } from "../core/driveCore.ts"
import { useStore } from "../core/store.ts"
import { maxLatencyOf } from "../core/linkWatch.ts"
import { disengagedBanner, disengagedText, linkChip } from "./barStatus.ts"
import { useKeyboard } from "./useKeyboard.ts"

const NO_PANELS = { toggleRail: () => {}, toggleFocus: () => {} }

export function BootShell({ core }: { core: DriveCore }) {
    useKeyboard(core.drive, core.profile, NO_PANELS, core.joy)
    const connection = useStore(core.connection.status)
    const { halt } = useStore(core.drive.state)
    const link = linkChip(connection, core.connection.latencyMs(), null, maxLatencyOf(useStore(core.settings).maxLatencyMs))
    const stop = () => core.drive.stop()
    return (
        <div className="boot-shell" data-testid="boot-shell">
            <div className="boot-shell-stage">
                <span>Loading the 3D view and panels…</span>
                <span className="boot-shell-hint">W / S drive, A / D turn, Q / E strafe, Space stops</span>
            </div>
            <header className="main-bar" data-testid="main-bar">
                <div className="main-bar-side left">
                    <Button className="top-stop" data-testid="stop-button" title="Stop now (Space, always)" onPointerDown={stop} onClick={stop}>
                        <span>STOP</span>
                        <Kbd className="lv-kbd">Space</Kbd>
                    </Button>
                </div>
                <div className="main-bar-middle">
                    <span className={`bar-chip tone-${link.tone} bar-link`} title={link.detail} data-testid="bar-link">
                        <span className="bar-dot" />
                        <span className="bar-value bar-link-value">{link.numbers ? `${link.numbers.rate} Mbps · ${link.numbers.ms} ms` : link.text}</span>
                    </span>
                </div>
                <div className="main-bar-side right" />
                {halt && (
                    <div className="drive-halt-banner" role="alert" data-testid="drive-halt-banner" title={disengagedText(halt)}>
                        <span>{disengagedBanner(halt)}</span>
                        <Button className="reconnect-button" data-testid="reconnect-button" disabled={halt.reconnecting} onClick={() => core.reconnect()}>
                            {halt.reconnecting ? "Reconnecting…" : "Reconnect"}
                        </Button>
                    </div>
                )}
            </header>
        </div>
    )
}
