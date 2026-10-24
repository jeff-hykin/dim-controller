// tf2_msgs.TFMessage topics, drawn: an axes gizmo and a name per frame, and a line from each frame to its parent.
// (Reading tf into the tree happens in core/tfFeed.ts whether or not this layer is on.)
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { FatLines } from "dimos-react/three"
import { LabelPool } from "dimos-react/three"
import { useStore, type Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { Field, Slider, Toggle } from "dimos-react"

export interface TfSettings {
    axesSize: number
    names: boolean
    links: boolean
}

const AXES_CAP = 512

class TfFramesLayer {
    readonly root = new THREE.Group()
    #axes: FatLines
    #links: FatLines
    #labels = new LabelPool("dr-scene-label dr-frame-label")
    #version = -1
    #fixedFrame = ""
    #problemFrames: ReadonlySet<string> = new Set()
    #problemLinks: FatLines

    constructor(readonly context: LayerContext, readonly settings: Store<TfSettings>) {
        this.#axes = new FatLines(context.viewer.resolution, { width: 2.5, vertexColors: true, capacity: AXES_CAP * 3 })
        this.#links = new FatLines(context.viewer.resolution, { width: 2.5, color: 0x9aa5b1, opacity: 0.8, dashed: false })
        // a flagged frame's link to its parent, in the warning color
        this.#problemLinks = new FatLines(context.viewer.resolution, { width: 4, color: 0xf59e0b, dashed: false })
        this.root.add(this.#axes.object, this.#links.object, this.#problemLinks.object, this.#labels.group)
        settings.subscribe(() => {
            this.#version = -1
            context.viewer.requestRender()
        })
    }

    update(frame: { fixedFrame: string }) {
        // only redraw when the tree changed
        const problemFrames = this.context.tfProblemFrames()
        if (this.context.tf.version === this.#version && frame.fixedFrame === this.#fixedFrame && problemFrames === this.#problemFrames) {
            return
        }
        this.#version = this.context.tf.version
        this.#fixedFrame = frame.fixedFrame
        this.#problemFrames = problemFrames
        const settings = this.settings.get()
        const snapshot = this.context.tf.snapshot()
        const red = new THREE.Color(0xef4444), green = new THREE.Color(0x22c55e), blue = new THREE.Color(0x3b82f6)
        this.#axes.clear()
        this.#links.clear()
        this.#problemLinks.clear()
        this.#labels.begin()
        const origin = new THREE.Vector3(), tip = new THREE.Vector3(), parent = new THREE.Vector3()
        let unplaced = 0
        for (const name of snapshot.frames.slice(0, AXES_CAP)) {
            const matrix = this.context.tf.lookup(name, frame.fixedFrame)
            if (!matrix) {
                unplaced++
                continue
            }
            origin.setFromMatrixPosition(matrix)
            for (const [axis, color] of [[new THREE.Vector3(1, 0, 0), red], [new THREE.Vector3(0, 1, 0), green], [new THREE.Vector3(0, 0, 1), blue]] as const) {
                tip.copy(axis).multiplyScalar(settings.axesSize).applyMatrix4(matrix)
                this.#axes.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z, color)
            }
            // a flagged frame (stale, say) is named and its link drawn in the warning color even with Names / Links off
            const flagged = problemFrames.has(name)
            if (settings.names || flagged) {
                this.#labels.place(flagged ? `⚠ ${name}` : name, origin, flagged ? "var(--warn)" : undefined).element.classList.toggle("tf-flagged", flagged)
            }
            const edge = snapshot.edges.find((other: { child: string; parent: string }) => other.child === name)
            const parentMatrix = edge && this.context.tf.lookup(edge.parent, frame.fixedFrame)
            if ((settings.links || flagged) && parentMatrix) {
                parent.setFromMatrixPosition(parentMatrix)
                ;(flagged ? this.#problemLinks : this.#links).push(origin.x, origin.y, origin.z, parent.x, parent.y, parent.z)
            }
        }
        this.#axes.commit()
        this.#links.commit()
        this.#problemLinks.commit()
        this.#labels.end()
        this.context.setStatus({ info: `${snapshot.frames.length} frames`, problem: unplaced ? `${unplaced} frames not connected to "${frame.fixedFrame}"` : null })
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#axes.dispose()
        this.#links.dispose()
        this.#problemLinks.dispose()
        this.#labels.dispose()
    }
}

function TfSettingsEditor({ settings }: { settings: Store<TfSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <Field inline label="Axes"><Slider min={0.01} max={1} step={0.01} value={value.axesSize} format={(size: number) => `${size} m`} onChange={(axesSize: number) => settings.update({ axesSize })} /></Field>
            <Field inline label="Names"><Toggle value={value.names} onChange={(names: boolean) => settings.update({ names })} /></Field>
            <Field inline label="Links"><Toggle value={value.links} onChange={(links: boolean) => settings.update({ links })} /></Field>
        </>
    )
}

registerLayer<TfSettings>({
    id: "tf",
    label: "TF frames",
    types: ["tf2_msgs.TFMessage"],
    defaults: { axesSize: 0.03, names: true, links: true },
    // off until asked for (the frames clutter the view)
    enabledByDefault: () => false,
    create: (context: LayerContext, _topic, settings) => new TfFramesLayer(context, settings),
    Settings: TfSettingsEditor,
})
