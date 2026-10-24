// Reloads open pages on request: whoever patches a robot's page (controller_hotpatch) writes reload.json ({"id": ...}) next
// to it, and every open page reloads once it sees an id it didn't start with. No reload.json (dev, or an rsync that
// removed it) reads as id "", so writing one later still counts as a change.
const CHECK_MS = 3000

export function watchReload() {
    let current: string | null = null
    const check = async () => {
        try {
            const response = await fetch("reload.json", { cache: "no-store" })
            const id = response.ok ? `${(await response.json()).id}` : ""
            if (current === null) {
                current = id
            } else if (id !== current && id !== "") {
                location.reload()
            }
            current = id
        } catch {
            // offline or mid-rsync: try again next time
        }
    }
    check()
    setInterval(check, CHECK_MS)
}
