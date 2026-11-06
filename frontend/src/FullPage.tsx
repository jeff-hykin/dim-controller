// The page past the drive core: every layer type, three.js and the panels (App.tsx), loaded as its own chunk by main.tsx.
// every built-in layer type registers itself on import; a fork adds its own files to layers/index.ts
import "./layers/index.ts"
import type { DriveCore } from "./core/driveCore.ts"
import { App } from "./App.tsx"

export default function FullPage({ core }: { core: DriveCore }) {
    return <App core={core} />
}
