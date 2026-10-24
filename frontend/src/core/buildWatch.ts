// Reloads the page when a new build lands next to it (a hot-patched robot: controller_hotpatch rsyncs a build in place, and
// every open page picks it up). The build writes build.json with its id (vite.config.ts); no build.json (dev) = no watch.
const CHECK_MS = 3000

export function watchBuild() {
    let current: string | null = null
    const check = async () => {
        try {
            const response = await fetch("build.json", { cache: "no-store" })
            if (!response.ok) {
                return
            }
            const { id } = await response.json()
            if (current === null) {
                current = id
            } else if (id !== current) {
                location.reload()
            }
        } catch {
            // offline or mid-rsync: try again next time
        }
    }
    check()
    setInterval(check, CHECK_MS)
}
