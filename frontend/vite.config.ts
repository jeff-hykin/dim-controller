import process from "node:process"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// served at /apps/<name>/, so every asset URL is relative; the dev server forwards the gateway and the backend to a
// running Desktop (DESKTOP_URL, default 7077) and to this app's own server through it
const desktop = process.env.DESKTOP_URL ?? "http://127.0.0.1:7077"
const app = process.env.APP_NAME ?? "dim-controller"

export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        proxy: {
            "/zenoh-gateway": { target: desktop, ws: true, changeOrigin: true },
            "/api": { target: `${desktop}/apps/${app}`, changeOrigin: true },
        },
    },
    build: { target: "es2022", chunkSizeWarningLimit: 1500 },
})
