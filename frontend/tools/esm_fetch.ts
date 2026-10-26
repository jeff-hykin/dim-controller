// A Vite plugin that bundles https imports (dimos-react's source on GitHub, as deno.json names it) instead of leaving
// them for the browser: each URL is fetched once into a cache folder (vite compiles its TypeScript), and the modules it
// imports by absolute or relative path resolve against its URL. Its bare imports (react, react-dom, three) resolve to
// this page's own, so there is one copy of each.
//   ESM_CACHE   the cache folder (default node_modules/.esm-cache)
//   ESM_OFFLINE set: a URL not in the cache is an error (nix builds offline from a prefetched cache)
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import type { Plugin } from "vite"

/** the dev server serves a fetched module under this path (a bare https id would be left for the browser to fetch, uncompiled) */
const DEV_PREFIX = "/@esm-fetch/"
const isUrl = (id: string) => /^https?:\/\//.test(id) || id.startsWith(DEV_PREFIX)
// (a browser folds the "//" of "https://" in a path to one slash: URL puts it back)
const urlOf = (id: string) => id.startsWith(DEV_PREFIX) ? new URL(id.slice(DEV_PREFIX.length)).href : id

export function esmFetch(aliases: Record<string, string>): Plugin {
    const cacheDir = process.env.ESM_CACHE ?? join(process.cwd(), "node_modules", ".esm-cache")
    const offline = !!process.env.ESM_OFFLINE
    const fileFor = (url: string) => join(cacheDir, createHash("sha256").update(url).digest("hex") + ".js")
    let serving = false
    const idFor = (url: string) => serving ? DEV_PREFIX + url : url
    return {
        name: "esm-fetch",
        enforce: "pre",
        configResolved(config) {
            serving = config.command === "serve"
        },
        resolveId(id, importer) {
            if (id in aliases) {
                return idFor(aliases[id])
            }
            if (isUrl(id)) {
                return idFor(urlOf(id))
            }
            // inside a fetched module: its absolute and relative imports are on its host
            // (not Vite's own /@vite, /@react-refresh)
            if (importer && isUrl(importer) && ((id.startsWith("/") && !id.startsWith("/@")) || id.startsWith("."))) {
                return idFor(new URL(id, urlOf(importer)).href)
            }
            return null
        },
        async load(rawId) {
            if (!isUrl(rawId)) {
                return null
            }
            const id = urlOf(rawId)
            const file = fileFor(id)
            if (existsSync(file)) {
                return readFileSync(file, "utf8")
            }
            if (offline) {
                throw new Error(`${id} isn't in the prefetched cache ${cacheDir} (ESM_OFFLINE): its nix hash needs updating`)
            }
            const response = await fetch(id)
            if (!response.ok) {
                throw new Error(`${id}: ${response.status} ${response.statusText}`)
            }
            const code = await response.text()
            mkdirSync(cacheDir, { recursive: true })
            writeFileSync(file, code)
            return code
        },
    }
}
