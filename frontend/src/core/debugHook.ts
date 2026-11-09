// A door into the running page, for debugging a scene that looks wrong.
//
// Some faults only exist in the live three.js graph -- the same wall drawn by two layers, a mesh
// at the wrong depth, a layer nobody meant to leave on. Reading those out of a screenshot is
// guesswork; this lets whoever is debugging ask the page directly, from the console or from a
// headless browser (`page.evaluate(() => __dim.sceneReport())`).
//
// It only reads. Nothing here changes what is drawn.
import * as THREE from "three"
import type { ViewerApp } from "./app.ts"
import { lastCloudShape, lastPlacedSample } from "../layers/pointcloud.tsx"
import { tfStampHealth } from "./tfFeed.ts"

/** What a layer put in the scene, and where. */
export interface DrawnReport {
    /** every layer entry the manager knows, and whether it is on */
    layers: { key: string; type: string; enabled: boolean }[]
    /** meshes actually visible in the scene, by the layer root they hang under */
    drawnByLayer: Record<string, number>
    /** visible meshes whose world centres coincide: the signature of one surface drawn twice */
    coincident: { at: string; count: number; under: string[] }[]
    visibleMeshes: number
}

/** Meshes that sit on top of each other, which is what z-fighting looks like from the graph. */
export function coincidentMeshes(
    scene: THREE.Object3D,
    owner: (o: THREE.Object3D) => string,
) {
    const centre = new THREE.Vector3()
    const buckets = new Map<string, { under: Set<string>; count: number }>()
    scene.updateMatrixWorld()
    scene.traverseVisible((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || !mesh.geometry) {
            return
        }
        if (!mesh.geometry.boundingSphere) {
            mesh.geometry.computeBoundingSphere()
        }
        if (!mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox()
        }
        const sphere = mesh.geometry.boundingSphere
        if (!sphere) {
            return
        }
        centre.copy(sphere.center).applyMatrix4(mesh.matrixWorld)
        // A millimetre grid: two draws of one surface land in the same cell, neighbours do not.
        //
        // The bounding sphere alone is not enough to say "the same surface": two different parts of
        // one asset that each span its full extent -- a shelf unit's frame and its shelves, a pair of
        // mirrored panels -- share a centre and a radius exactly, and got reported as duplicates.
        // Chasing one of those cost an hour, so the vertex count and the box go in the key too:
        // geometry drawn twice matches on all of them, parts that merely sit inside each other do not.
        const position = mesh.geometry.getAttribute("position")
        const box = mesh.geometry.boundingBox
        const key = [centre.x, centre.y, centre.z].map((v) =>
            Math.round(v * 1000)
        ).join(",") +
            `|r${Math.round(sphere.radius * 1000)}` +
            `|n${position ? position.count : 0}` +
            `|b${box ? [box.min, box.max].map((corner) => [corner.x, corner.y, corner.z].map((v) => Math.round(v * 1000)).join(",")).join("/") : "?"}`
        const found = buckets.get(key) ?? { under: new Set<string>(), count: 0 }
        found.count++
        found.under.add(owner(mesh))
        buckets.set(key, found)
    })
    return [...buckets.entries()]
        .filter(([, v]) => v.count > 1)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([at, v]) => ({ at, count: v.count, under: [...v.under] }))
}

/** Installs `globalThis.__dim`. Safe to call more than once. */
export function installDebugHook(app: ViewerApp) {
    const named = (object: THREE.Object3D): string => {
        for (let node: THREE.Object3D | null = object; node; node = node.parent) {
            const tag = node.userData.debugOwner as string | undefined
            if (tag) {
                return tag
            }
            if (node.parent === app.viewer.scene) {
                return node.name || node.type
            }
        }
        return "?"
    }
    const hook = {
        app,
        viewer: app.viewer,
        scene: app.viewer.scene,
        THREE,
        /**
         * Is the last cloud actually placed at its own stamp, or clamped to "now"?
         *
         * `clamped` true on any edge means that edge had nothing kept at the cloud's time and
         * returned its newest sample instead -- the behaviour the stamps were meant to replace,
         * and indistinguishable on screen from no fix at all.
         */
        placementReport() {
            const cloud = lastCloudShape
            if (!cloud || cloud.takenAtMs === null || !cloud.frame) {
                return { error: "no cloud with a stamp and a frame yet", cloud }
            }
            const fixed = app.viewer.fixedFrame
            return {
                frame: cloud.frame,
                fixedFrame: fixed,
                takenAtMs: cloud.takenAtMs,
                arrivedAtMs: cloud.arrivedAtMs,
                /** how far the two clocks are apart right now, read off one message */
                arrivalMinusTakenMs: cloud.arrivedAtMs === null ? null : Math.round(cloud.arrivedAtMs - cloud.takenAtMs),
                coverage: app.tfHistory.coverage(cloud.frame, fixed, cloud.takenAtMs),
                // What the correction is actually worth: the pose used, against the pose "now".
                // If these agree the by-stamp lookup is changing nothing and the fault is elsewhere.
                versusNow: (() => {
                    const taken = app.tfHistory.lookupAt(cloud.frame!, fixed, cloud.takenAtMs!)
                    const now = app.tfHistory.lookupAt(cloud.frame!, fixed, Number.MAX_SAFE_INTEGER)
                    if (!taken || !now) {
                        return { error: "no transform", taken: !!taken, now: !!now }
                    }
                    const a = new THREE.Quaternion().setFromRotationMatrix(taken)
                    const b = new THREE.Quaternion().setFromRotationMatrix(now)
                    const pa = new THREE.Vector3().setFromMatrixPosition(taken)
                    const pb = new THREE.Vector3().setFromMatrixPosition(now)
                    return {
                        degreesApart: Number((2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI).toFixed(3)),
                        metresApart: Number(pa.distanceTo(pb).toFixed(4)),
                    }
                })(),
            }
        },
        /**
         * Whether tf could stand in for the clouds' own stamps.
         *
         * Read `quickestGapMs`, not `medianGapMs`. Here the median is ~115581 ms and the quickest
         * ~8 ms: tf carries edges stamped on the sim's clock and edges stamped on wall time, and an
         * offset is read off the quickest sample, so feeding this to the clock reads the wall-stamped
         * ones and puts every cloud two minutes in the past. The median says they agree. They do not.
         */
        tfStampReport() {
            const gaps = [...tfStampHealth.gapMs].sort((a, b) => a - b)
            return {
                transforms: tfStampHealth.transforms,
                withStamp: tfStampHealth.withStamp,
                medianGapMs: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
                // the one that matters: an offset is read off the quickest sample, not the median
                quickestGapMs: Number.isFinite(tfStampHealth.quickestGapMs) ? tfStampHealth.quickestGapMs : null,
                edgesWithout: [...tfStampHealth.edgesWithout].slice(0, 20),
                wallStampedCount: tfStampHealth.wallStamped.size,
                simStampedCount: tfStampHealth.simStamped.size,
                // the publishers to fix: these are stamping wall time where everything else is on sim time
                wallStamped: [...tfStampHealth.wallStamped.entries()].slice(0, 40).map(([edge, gap]) => `${edge} +${Math.round(gap)}ms`),
                simStampedSample: [...tfStampHealth.simStamped.keys()].slice(0, 8),
                // the same edge from two publishers: the tree keeps whichever arrived last
                doubled: [...tfStampHealth.topicsPerEdge.entries()]
                    .filter(([, topics]) => topics.size > 1)
                    .slice(0, 20)
                    .map(([edge, topics]) => `${edge} on ${[...topics].join(" + ")}`),
                bothClocks: [...tfStampHealth.wallStamped.keys()].filter((edge) => tfStampHealth.simStamped.has(edge)).slice(0, 20),
            }
        },
        /** The last scan as the viewer placed it: points already in the fixed frame. */
        placedPoints() {
            const sample = lastPlacedSample
            if (!sample) {
                return { error: "no placed scan yet" }
            }
            const matrix = new THREE.Matrix4().fromArray(sample.matrix)
            const point = new THREE.Vector3()
            const world: number[] = []
            for (let index = 0; index + 2 < sample.points.length; index += 3) {
                point.set(sample.points[index], sample.points[index + 1], sample.points[index + 2])
                point.applyMatrix4(matrix)
                world.push(Number(point.x.toFixed(3)), Number(point.y.toFixed(3)), Number(point.z.toFixed(3)))
            }
            return { stamp: sample.stamp, fixedFrame: app.viewer.fixedFrame, count: world.length / 3, world }
        },
        /** What is on, what is drawn, and what is drawn twice. */
        sceneReport(): DrawnReport {
            const layers = app.layers.entries.get().list.map((entry) => ({
                key: entry.topic.key,
                type: entry.type.id,
                enabled: entry.enabled,
            }))
            const drawnByLayer: Record<string, number> = {}
            let visibleMeshes = 0
            app.viewer.scene.updateMatrixWorld()
            app.viewer.scene.traverseVisible((object) => {
                if ((object as THREE.Mesh).isMesh) {
                    visibleMeshes++
                    const owner = named(object)
                    drawnByLayer[owner] = (drawnByLayer[owner] ?? 0) + 1
                }
            })
            return {
                layers,
                drawnByLayer,
                coincident: coincidentMeshes(app.viewer.scene, named).slice(0, 20),
                visibleMeshes,
            }
        },
    }
    // leading semicolon: without it the `(` continues the object literal above
    ;(globalThis as unknown as Record<string, unknown>).__dim = hook
    return hook
}
