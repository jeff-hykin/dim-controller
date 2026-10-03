// Recording: start/stop, which topics (rpc ones grouped and off by default; choices remembered), formats, and
// the saved files (size, age, download, copy path, delete with a second click).
import { useEffect, useState } from "react"
import type { ViewerApp } from "../core/app.ts"
import { persistentStore, useStore } from "../core/store.ts"
import { recorder } from "../core/recorder.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Select, Toggle } from "./controls.tsx"
import { Icon } from "./icons.tsx"

/** topic key → chosen on/off; untouched topics fall back to the default (on, rpc off) so new ones are picked up */
const overrides = persistentStore<Record<string, boolean>>("lv.record.topics", {})
const options = persistentStore<{ recordNew: boolean }>("lv.record.options", { recordNew: true })

export const isRpcTopic = (topic: Topic) => /^\/rpc\//.test(topic.name) || /\/(req|res)$/.test(topic.name)
export const wantsRecording = (topic: Topic, chosen: Record<string, boolean>) => chosen[topic.key] ?? !isRpcTopic(topic)

const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
const age = (seconds: number) => seconds < 90 ? `${Math.round(seconds)} s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : seconds < 129600 ? `${Math.round(seconds / 3600)} h ago` : `${Math.round(seconds / 86400)} d ago`

/** While recording, topics that first appear after it started (and are wanted) join the file. */
export function followNewTopics(app: ViewerApp) {
    // the topics on the bridge when the recording started: the user already chose among those
    let seenAtStart: Set<string> | null = null
    const check = () => {
        const status = recorder.status.get()
        const topics = app.connection.status.get().topics
        if (!status.recording.active) {
            seenAtStart = null
            return
        }
        if (seenAtStart === null) {
            seenAtStart = new Set(topics.map((topic) => topic.key))
            return
        }
        if (!options.get().recordNew) {
            return
        }
        const recording = new Set(status.keys)
        const fresh = topics.filter((topic) => !seenAtStart!.has(topic.key) && !recording.has(topic.key) && wantsRecording(topic, overrides.get())).map((topic) => topic.key)
        for (const key of fresh) {
            seenAtStart.add(key)
        }
        if (fresh.length) {
            recorder.add(fresh).then(() => recorder.refresh()).catch(() => {})
        }
    }
    app.connection.status.subscribe(check)
    recorder.status.subscribe(check)
}

function TopicRow({ topic, chosen }: { topic: Topic; chosen: Record<string, boolean> }) {
    return (
        <label className="record-topic">
            <input type="checkbox" checked={wantsRecording(topic, chosen)} onChange={(event) => overrides.update({ [topic.key]: event.target.checked })} />
            <span className="topic-name">{topic.name}</span>
            <span className="topic-type">{topic.type.split(".")[1]}</span>
        </label>
    )
}

export function RecorderPanel({ app }: { app: ViewerApp }) {
    const status = useStore(recorder.status)
    const { topics } = useStore(app.connection.status)
    const chosen = useStore(overrides)
    const { recordNew } = useStore(options)
    const [confirm, setConfirm] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [showRpc, setShowRpc] = useState(false)
    useEffect(() => recorder.watch(), [])

    const plain = topics.filter((topic) => !isRpcTopic(topic))
    const rpc = topics.filter(isRpcTopic)
    const selected = topics.filter((topic) => wantsRecording(topic, chosen))
    const active = status.recording.active
    const run = (work: Promise<unknown>) => work.then(() => setError(null)).catch((problem) => setError(String(problem.message ?? problem)))

    return (
        <div className="recorder">
            {status.unavailable && <p className="problem">{status.unavailable}</p>}
            <button
                type="button"
                className={`dim-btn lg record-button ${active ? "danger recording" : ""}`}
                disabled={!!status.unavailable || (!active && !selected.length)}
                onClick={() => run(active ? recorder.stop() : recorder.start(selected.map((topic) => topic.key)))}
            >
                <span className="record-dot" />
                {active ? `Stop · ${status.recording.seconds.toFixed(0)} s · ${megabytes(status.recording.bytes)}` : `Record ${selected.length} topics`}
            </button>
            {active && (
                <p className="hint">
                    {status.recording.messages.toLocaleString()} messages{status.recording.dropped ? ` · ${status.recording.dropped} dropped (disk too slow)` : ""} · {status.recording.path}
                </p>
            )}
            {error && <p className="problem">{error}</p>}
            <Field label="Images">
                <Select
                    value={status.settings.image_format}
                    options={[["raw", "raw (exact)"], ["png", "png (lossless)"], ["jpegxl", "jpeg xl (lossless)"], ["webp", "webp"], ["jpeg", "jpeg"]]}
                    onChange={(image_format) => run(recorder.settings({ image_format: image_format as never }))}
                />
            </Field>
            <Field label="Chunks">
                <Select value={status.settings.compression} options={[["none", "uncompressed"], ["lz4", "lz4"], ["zstd", "zstd"]]} onChange={(compression) => run(recorder.settings({ compression: compression as never }))} />
            </Field>
            <Field label="New topics"><Toggle value={recordNew} onChange={(value) => options.update({ recordNew: value })} label="join a running recording" /></Field>
            <Field label="Folder"><input className="dim-input" defaultValue={status.directory} key={status.directory} disabled={active} onBlur={(event) => event.target.value !== status.directory && run(recorder.settings({ directory: event.target.value }))} /></Field>

            <h3 className="dim-label">Topics · {selected.length} of {topics.length}</h3>
            <div className="record-topics">
                {plain.map((topic) => <TopicRow key={topic.key} topic={topic} chosen={chosen} />)}
                {rpc.length > 0 && (
                    <div className="rpc-group">
                        <label className="record-topic">
                            <input
                                type="checkbox"
                                checked={rpc.every((topic) => wantsRecording(topic, chosen))}
                                ref={(element) => {
                                    if (element) {
                                        element.indeterminate = rpc.some((topic) => wantsRecording(topic, chosen)) && !rpc.every((topic) => wantsRecording(topic, chosen))
                                    }
                                }}
                                onChange={(event) => overrides.update(Object.fromEntries(rpc.map((topic) => [topic.key, event.target.checked])))}
                            />
                            <span className="topic-name">{rpc.length} rpc topics</span>
                            <button type="button" className="link" onClick={(event) => { event.preventDefault(); setShowRpc(!showRpc) }}>{showRpc ? "hide" : "show"}</button>
                        </label>
                        {showRpc && rpc.map((topic) => <TopicRow key={topic.key} topic={topic} chosen={chosen} />)}
                    </div>
                )}
            </div>

            <h3 className="dim-label">Recordings</h3>
            {!status.files.length && <p className="empty">none yet</p>}
            <ul className="files">
                {status.files.map((file) => (
                    <li key={file.name} className="file">
                        <span className="file-name" title={file.path}>{file.name}</span>
                        <span className="file-meta">{megabytes(file.bytes)} · {age(file.seconds_old)}</span>
                        <a className="dim-btn icon icon-button" href={recorder.downloadUrl(file)} download={file.name.split("/").pop()} title="Download"><Icon name="download" size={16} /></a>
                        <button type="button" className="dim-btn icon icon-button" title="Copy path" onClick={() => navigator.clipboard?.writeText(file.path)}><Icon name="copy" size={16} /></button>
                        <button
                            type="button"
                            className={`dim-btn icon icon-button ${confirm === file.name ? "danger" : ""}`}
                            title={confirm === file.name ? "Click again to delete" : "Delete"}
                            onClick={() => {
                                if (confirm === file.name) {
                                    setConfirm(null)
                                    run(recorder.remove(file))
                                } else {
                                    setConfirm(file.name)
                                }
                            }}
                        >
                            <Icon name="trash" size={16} />
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}
