// Snapshots (core/snapshots.ts): the snapshot and gallery buttons the 3D view and each camera panel carry in their tools,
// and the gallery itself: every snapshot on the backend as a thumbnail grid; a click shows it full size, with download
// and delete.
import { useState } from "react"
import { Button, EmptyState, Modal, toast } from "dimos-react"
import { useStore } from "../core/store.ts"
import { deleteSnapshot, downloadName, type Snapshot, snapshots, snapshotUrl } from "../core/snapshots.ts"
import { formatBytes } from "../core/cloudQuality.ts"
import { Icon } from "./icons.tsx"

const openGallery = () => snapshots.update({ galleryOpen: true })

/** A snapshot button (`take` makes the picture and saves it) and the gallery's, with how many there are. */
export function SnapshotTools({ what, take }: { what: string; take: () => Promise<unknown> }) {
    const { list } = useStore(snapshots)
    const [busy, setBusy] = useState(false)
    const shoot = async () => {
        setBusy(true)
        try {
            await take()
            toast.ok(`Snapshot of the ${what} saved`, { action: { label: "Gallery", onClick: openGallery } })
        } catch (error) {
            toast.error(`Couldn't take a snapshot of the ${what}: ${(error as Error).message}`)
        } finally {
            setBusy(false)
        }
    }
    return (
        <>
            <Button className="dr-btn--icon icon-button snapshot-take" disabled={busy} title={`Snapshot: save the ${what} as it looks now to the gallery`} aria-label={`Snapshot of the ${what}`} onClick={shoot}>
                <Icon name="camera" size={15} />
            </Button>
            <Button className="dr-btn--icon icon-button snapshot-gallery" title={`Snapshot gallery (${list.length})`} aria-label="Snapshot gallery" onClick={openGallery}>
                <Icon name="grid" size={15} />
                {list.length > 0 && <span className="scene-count">{list.length}</span>}
            </Button>
        </>
    )
}

const describe = (snapshot: Snapshot) => `${snapshot.view === "3d" ? "3D view" : snapshot.source || "camera"} · ${new Date(snapshot.created).toLocaleString()}`

/** The gallery (one for the page): open from any gallery button. */
export function SnapshotGallery() {
    const { list, galleryOpen } = useStore(snapshots)
    const [shown, setShown] = useState<string | null>(null)
    const current = list.find((snapshot) => snapshot.name === shown) ?? null
    const close = () => {
        setShown(null)
        snapshots.update({ galleryOpen: false })
    }
    const remove = (snapshot: Snapshot) => {
        deleteSnapshot(snapshot.name).catch((error) => toast.error(`Couldn't delete the snapshot: ${error.message}`))
        if (shown === snapshot.name) {
            setShown(null)
        }
    }
    return (
        <Modal
            open={galleryOpen}
            onClose={close}
            title={current ? describe(current) : `Snapshots (${list.length})`}
            size="xl"
            data-testid="snapshot-gallery"
            footer={current && (
                <>
                    <Button onClick={() => setShown(null)}><Icon name="chevron-left" size={14} /> All snapshots</Button>
                    <SnapshotActions snapshot={current} onDelete={() => remove(current)} />
                </>
            )}
        >
            {current
                ? <img className="snapshot-full" src={snapshotUrl(current.name)} alt={describe(current)} />
                : !list.length
                ? <EmptyState icon="camera" title="No snapshots yet" message="The camera button in the 3D view's or a camera panel's tools saves what it shows here." />
                : (
                    <div className="snapshot-grid">
                        {list.map((snapshot) => (
                            <figure key={snapshot.name} className="snapshot-tile">
                                <button type="button" className="snapshot-thumb" title={`${describe(snapshot)} (${formatBytes(snapshot.bytes)}): click for full size`} onClick={() => setShown(snapshot.name)}>
                                    <img src={snapshotUrl(snapshot.name)} alt={describe(snapshot)} loading="lazy" />
                                </button>
                                <figcaption>
                                    <span className="snapshot-caption">{describe(snapshot)}</span>
                                    <SnapshotActions snapshot={snapshot} onDelete={() => remove(snapshot)} compact />
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                )}
        </Modal>
    )
}

function SnapshotActions({ snapshot, onDelete, compact = false }: { snapshot: Snapshot; onDelete: () => void; compact?: boolean }) {
    return (
        <span className="snapshot-actions">
            <a className={`dr-btn ${compact ? "dr-btn--icon icon-button" : ""}`} href={snapshotUrl(snapshot.name)} download={downloadName(snapshot)} title="Download the PNG" aria-label="Download">
                <Icon name="download" size={14} />
                {!compact && " Download"}
            </a>
            <Button className={compact ? "dr-btn--icon icon-button" : ""} title="Delete this snapshot for good" aria-label="Delete" onClick={onDelete}>
                <Icon name="trash" size={14} />
                {!compact && " Delete"}
            </Button>
        </span>
    )
}
