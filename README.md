# dim-live-viewer

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app that renders a
**live 3D scene** of a running DimOS stack — the way the PimSim frontend does,
but fed by live data off the DimOS bridge (works with the sim *or* a real robot).

- **Robot** — body + pose gizmo + odometry trail.
- **Point clouds** — lidar, terrain, costmap, PGO pose-graph nodes (TF-placed,
  height-gradient colored).
- **Planned path** and pose-graph edges.
- **First-person camera** — a picture-in-picture of the robot's color camera.

Everything is **discovered dynamically**: the app subscribes to every stream on
the bridge and decides how to draw each one by *duck-typing the decoded message*
— there is no hardcoded list of topic names. Streams are placed in a common
world frame via the live `/tf` tree (each cloud is transformed by its own
`header.frame_id`). The UI follows the desktop's light/dark theme.

| Dark | Light |
| --- | --- |
| ![Live scene, dark theme](docs/dark.png) | ![Live scene, light theme](docs/light.png) |

Running as an app in the DimOS desktop:

![Live Viewer in the DimOS desktop](docs/desktop.png)

## Install

```sh
dim install https://github.com/jeff-hykin/dim-live-viewer
```

Then open **Live Viewer** from the desktop rail while a DimOS stack (sim or
robot) is running — its streams appear as they start flowing.

## How it works

- `dim/apps/live_viewer/main.js` — the backend half (runs in the Deno desktop).
  It watches the bridge's `__meta/streams` meter, subscribes to every non-meta
  stream, decodes each with [`@dimos/msgs`](https://jsr.io/@dimos/msgs),
  duck-types it into a render kind (cloud / odom / tf / path / image),
  downsamples clouds and rate-limits, and forwards compact frames to the UI.
- `dim/apps/live_viewer/frontend/index.html` — the UI: a
  [three.js](https://threejs.org) scene (ROS Z-up) built from the forwarded
  frames, imported straight from esm.sh (no build step). Robot access is only
  ever through the bridge (`ctx.Dimos`).

## License

Apache-2.0 — see [LICENSE](LICENSE).
