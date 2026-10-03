// follow dimOS Desktop's light/dark (sets body.dark) before the first render
import "./dim-theme.js"
import { createRoot } from "react-dom/client"
import "./theme.css"
import "./styles.css"
// every built-in layer type registers itself on import; a fork adds its own files to layers/index.ts
import "./layers/index.ts"
import { App } from "./App.tsx"

createRoot(document.getElementById("root")!).render(<App />)
