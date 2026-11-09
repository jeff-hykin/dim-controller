// Location labels: text pinned to a point, made from the 3D view's right-click menu. They are dimos's named locations
// (core/namedLocations.ts) and nothing else: the page publishes each edit straight onto the module's topic and draws the
// list the module sends back, so every page and the recording see the same thing. Drawn here as a marker plus its text,
// placed through TF like the annotations. With no module running there are no labels and an edit is refused.
import * as THREE from "three"
import { LabelPool } from "dimos-react/three"
import { Store } from "./store.ts"
import type { ViewerApp } from "./app.ts"
import { type NamedLocations, renamedLocation, withLocation, withoutLocation } from "./namedLocations.ts"

export interface LocationLabel {
    id: string
    label: string
    frame_id: string
    position: [number, number, number]
    /** quaternion x, y, z, w */
    orientation: [number, number, number, number]
    /** ns since the epoch */
    created: number
}

const COLOR = "#ffd166"

export class LocationLabels {
    /** what's drawn: the module's locations, empty until it sends them */
    readonly list = new Store<LocationLabel[]>([])
    readonly group = new THREE.Group()
    #text = new LabelPool("dr-scene-label dr-note")
    #markers = new Map<string, THREE.Mesh>()
    #geometry = new THREE.SphereGeometry(0.07, 16, 12)
    #material = new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false, transparent: true })

    constructor(readonly app: ViewerApp, readonly named: NamedLocations) {
        named.state.subscribe(() => this.#show())
        this.group.userData.noPick = true
        this.group.add(this.#text.group)
        app.viewer.scene.add(this.group)
        app.viewer.onFrame(() => this.#place())
    }

    #show() {
        const labels = this.named.state.get().locations ?? []
        this.list.set(labels)
        const wanted = new Set(labels.map((label) => label.id))
        for (const [id, marker] of this.#markers) {
            if (!wanted.has(id)) {
                marker.removeFromParent()
                this.#markers.delete(id)
            }
        }
        for (const label of labels) {
            if (!this.#markers.has(label.id)) {
                const marker = new THREE.Mesh(this.#geometry, this.#material)
                marker.renderOrder = 11
                this.group.add(marker)
                this.#markers.set(label.id, marker)
            }
        }
        this.app.viewer.requestRender()
    }

    /** Where a label is in the current fixed frame, or null without a TF path. */
    position(label: LocationLabel): THREE.Vector3 | null {
        const fixed = this.app.viewer.fixedFrame
        const transform = label.frame_id === fixed ? new THREE.Matrix4() : this.app.tf.lookup(label.frame_id, fixed)
        return transform ? new THREE.Vector3(...label.position).applyMatrix4(transform) : null
    }

    #place() {
        this.#text.begin()
        for (const label of this.list.get()) {
            const marker = this.#markers.get(label.id)
            const position = this.position(label)
            if (!marker) {
                continue
            }
            marker.visible = !!position
            if (!position) {
                continue
            }
            if (!marker.position.equals(position)) {
                marker.position.copy(position)
                this.app.viewer.requestRender()
            }
            this.#text.place(label.label, position.clone().add(new THREE.Vector3(0, 0, 0.3)), COLOR)
        }
        this.#text.end()
    }

    /** `point` in `frame`, re-expressed through TF in the frame the module's list is in (as is, while the list is empty: the module re-expresses it). */
    #inListFrame(point: THREE.Vector3, frame: string): { frame_id: string; position: [number, number, number] } {
        const target = this.named.frame ?? frame
        if (frame === target) {
            return { frame_id: target, position: point.toArray() }
        }
        const transform = this.app.tf.lookup(frame, target)
        if (!transform) {
            throw new Error(`no transform from ${frame} to ${target} yet`)
        }
        return { frame_id: target, position: point.clone().applyMatrix4(transform).toArray() }
    }

    #taken(name: string) {
        if (this.list.get().some((label) => label.id === name)) {
            throw new Error(`there's already a location named “${name}”`)
        }
    }

    /** Adds a location at `point` (in `frame`), onto the module's topic. */
    async create(text: string, point: THREE.Vector3, frame = this.app.viewer.fixedFrame): Promise<void> {
        this.#taken(text)
        await this.named.publish(withLocation(this.named.current, { label: text, ...this.#inListFrame(point, frame), orientation: [0, 0, 0, 1] }))
    }

    /** Gives a location new text, where it is. */
    async rename(label: LocationLabel, text: string) {
        if (text !== label.id) {
            this.#taken(text)
        }
        return await this.named.publish(renamedLocation(this.named.current, label.id, text))
    }

    async remove(id: string) {
        return await this.named.publish(withoutLocation(this.named.current, id))
    }

    /** POST api/view/label (server/src/annotations.rs page_label): an edit as the menu makes it, asked of this page. */
    async fromAgent({ action = "add", id, label, position, frame_id }: { action?: string; id?: string; label?: string; position?: number[]; frame_id?: string }) {
        const found = this.list.get().find((one) => one.id === id)
        if ((action === "rename" || action === "remove") && !found) {
            throw new Error(`no label ${id}`)
        }
        if (action === "add") {
            const [x, y, z = 0] = position!
            await this.create(label!.trim(), new THREE.Vector3(x, y, z), frame_id || undefined)
        } else if (action === "rename") {
            await this.rename(found!, label!.trim())
        } else if (action === "remove") {
            await this.remove(found!.id)
        }
        return { ok: true, via: "named_locations", labels: this.list.get() }
    }

    /** The label drawn nearest to a screen point (CSS px in the canvas), within `radius` px. */
    near(x: number, y: number, radius = 24): LocationLabel | null {
        const canvas = this.app.viewer.canvas.getBoundingClientRect()
        let best: { label: LocationLabel; distance: number } | null = null
        for (const label of this.list.get()) {
            const position = this.position(label)
            if (!position) {
                continue
            }
            const projected = position.clone().project(this.app.viewer.camera)
            if (projected.z > 1) {
                continue
            }
            const screenX = canvas.left + ((projected.x + 1) / 2) * canvas.width
            const screenY = canvas.top + ((1 - projected.y) / 2) * canvas.height
            const distance = Math.hypot(screenX - x, screenY - y)
            if (distance <= radius && (!best || distance < best.distance)) {
                best = { label, distance }
            }
        }
        return best?.label ?? null
    }
}
