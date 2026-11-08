// A door into the running page, for debugging a scene that looks wrong.
//
// Some faults only exist in the live three.js graph -- the same wall drawn by two layers, a mesh
// at the wrong depth, a layer nobody meant to leave on. Reading those out of a screenshot is
// guesswork; this lets whoever is debugging ask the page directly, from the console or from a
// headless browser (`page.evaluate(() => __dim.sceneReport())`).
//
// It only reads. Nothing here changes what is drawn.
import * as THREE from "three";
import type { ViewerApp } from "./app.ts";

/** What a layer put in the scene, and where. */
export interface DrawnReport {
  /** every layer entry the manager knows, and whether it is on */
  layers: { key: string; type: string; enabled: boolean }[];
  /** meshes actually visible in the scene, by the layer root they hang under */
  drawnByLayer: Record<string, number>;
  /** visible meshes whose world centres coincide: the signature of one surface drawn twice */
  coincident: { at: string; count: number; under: string[] }[];
  visibleMeshes: number;
}

/** Meshes that sit on top of each other, which is what z-fighting looks like from the graph. */
function coincidentMeshes(
  scene: THREE.Object3D,
  owner: (o: THREE.Object3D) => string,
) {
  const centre = new THREE.Vector3();
  const buckets = new Map<string, { under: Set<string>; count: number }>();
  scene.updateMatrixWorld();
  scene.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }
    if (!mesh.geometry.boundingSphere) {
      mesh.geometry.computeBoundingSphere();
    }
    const sphere = mesh.geometry.boundingSphere;
    if (!sphere) {
      return;
    }
    centre.copy(sphere.center).applyMatrix4(mesh.matrixWorld);
    // a millimetre grid: two draws of one surface land in the same cell, neighbours do not
    const key = [centre.x, centre.y, centre.z].map((v) =>
      Math.round(v * 1000)
    ).join(",") +
      `|r${Math.round(sphere.radius * 1000)}`;
    const found = buckets.get(key) ?? { under: new Set<string>(), count: 0 };
    found.count++;
    found.under.add(owner(mesh));
    buckets.set(key, found);
  });
  return [...buckets.entries()]
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([at, v]) => ({ at, count: v.count, under: [...v.under] }));
}

/** Installs `globalThis.__dim`. Safe to call more than once. */
export function installDebugHook(app: ViewerApp) {
  const named = (object: THREE.Object3D): string => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const tag = node.userData.debugOwner as string | undefined;
      if (tag) {
        return tag;
      }
      if (node.parent === app.viewer.scene) {
        return node.name || node.type;
      }
    }
    return "?";
  };
  const hook = {
    app,
    viewer: app.viewer,
    scene: app.viewer.scene,
    THREE,
    /** What is on, what is drawn, and what is drawn twice. */
    sceneReport(): DrawnReport {
      const layers = app.layers.entries.get().list.map((entry) => ({
        key: entry.topic.key,
        type: entry.type.id,
        enabled: entry.enabled,
      }));
      const drawnByLayer: Record<string, number> = {};
      let visibleMeshes = 0;
      app.viewer.scene.updateMatrixWorld();
      app.viewer.scene.traverseVisible((object) => {
        if ((object as THREE.Mesh).isMesh) {
          visibleMeshes++;
          const owner = named(object);
          drawnByLayer[owner] = (drawnByLayer[owner] ?? 0) + 1;
        }
      });
      return {
        layers,
        drawnByLayer,
        coincident: coincidentMeshes(app.viewer.scene, named).slice(0, 20),
        visibleMeshes,
      };
    },
  };
  (globalThis as unknown as Record<string, unknown>).__dim = hook;
  return hook;
}
