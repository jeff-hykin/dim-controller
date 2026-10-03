// follow dimOS Desktop's light/dark (sets body.dark) before the first render
import "./dim-theme.js"
import { createRoot } from "react-dom/client"
import "./theme.css"
import "./styles.css"
// every built-in layer type registers itself on import; a fork adds its own files to layers/index.ts
import "./layers/index.ts"
import { App } from "./App.tsx"
import { loadSettings } from "./core/store.ts"

// the settings are the backend's (api/settings): the app starts once they're here
loadSettings().then(() => createRoot(document.getElementById("root")!).render(<App />))
