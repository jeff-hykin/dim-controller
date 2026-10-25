import { readFileSync } from "node:fs"
import process from "node:process"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { esmFetch } from "./tools/esm_fetch.ts"

// served at /apps/<name>/, so every asset URL is relative; the dev server forwards the gateway and the backend to a
// running Desktop (DESKTOP_URL, default 7077) and to this app's own server through it
const desktop = process.env.DESKTOP_URL ?? "http://127.0.0.1:7077"
const app = process.env.APP_NAME ?? "dim-controller"
const imports: Record<string, string> = JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8")).imports
// dimos-react and dimos-lcm: their TypeScript source on GitHub (deno.json's URLs, the same files deno and the tests read),
// fetched and compiled into the page; dimos-react's react, react-dom and three resolve to this page's own
const fetched = Object.fromEntries(Object.entries(imports).filter(([name]) => /^dimos-(react|lcm)/.test(name)))

export default defineConfig({
    base: "./",
    // dimos-react's and dimos-lcm's source is fetched at build (tools/esm_fetch.ts)
    plugins: [esmFetch(fetched), react()],
    server: {
        proxy: {
            "/zenoh-gateway": { target: desktop, ws: true, changeOrigin: true },
            "/api": { target: `${desktop}/apps/${app}`, changeOrigin: true },
        },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
})
