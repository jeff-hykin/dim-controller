import { createRoot } from "react-dom/client"
import { lazy, Suspense } from "react"
import { AppProvider } from "dimos-react"
import "./styles.css"
import { loadSettings } from "./core/store.ts"
import { watchReload } from "./core/reloadWatch.ts"
import { DriveCore } from "./core/driveCore.ts"
import { BootShell } from "./ui/BootShell.tsx"

watchReload()

// the 3D view and the panels (three.js, every layer type) are their own chunk, asked for now, alongside the settings: until
// it's here the bar's STOP, the link and the keys already drive (ui/BootShell.tsx), through the same core it then takes over
const fullPage = import("./FullPage.tsx")
const FullPage = lazy(() => fullPage)

// the settings are the backend's (api/settings): the app starts once they're here. AppProvider: Desktop's skin (live),
// toasts and dialogs; the page's zenoh connection is the app's own (core/transport.ts), so no URL-state bridge
loadSettings().then(() => {
    const core = new DriveCore()
    createRoot(document.getElementById("root")!).render(
        <AppProvider url={false}>
            <Suspense fallback={<BootShell core={core} />}>
                <FullPage core={core} />
            </Suspense>
        </AppProvider>,
    )
})
