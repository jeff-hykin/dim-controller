# dim-controller

A [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) app for driving a running dimOS robot while watching
it: a low-latency 3D view placed by TF (point clouds, costmap, pose, planned path), live cameras, driving (keyboard, or
sticks on a phone, armed and with a deadman) and an mcap recorder. It is the one canonical controller: it replaces
web_ctrl, the Live Viewer (its old name), `dimos-controller` and `dim-app-minimal-kb-control` (Teleop), and is meant to
be **forked per robot** (see [Fork this for your robot](#fork-this-for-your-robot)).

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-controller
```

Then open **Controller** from the rail while a blueprint (sim, replay or robot) runs on zenoh. Topics appear as they
start flowing; nothing is configured by topic name.

Every action is an HTTP endpoint the page itself uses, and Desktop's agent calls the same ones: arming, driving,
recording, labels, annotations, the camera, and every setting the panels change (layers on/off, layer styles, point
style, fixed frame, follow, drive speeds/topic, which topics to record). `server/src/api.rs` registers each with its
description; that table is the served `/agent.json`, and `dimos.yaml`'s `agent:` repeats it (`deno task
check-endpoints [--write]`, checked in CI). Settings live in the backend (`GET` / `PATCH api/settings`, saved in the
app's data dir), so a change from the agent or another window shows up in every open page. The one exception is
continuous driving from the keys and sticks, which publishes through the bridge at 20 Hz with the bridge's deadman;
`POST api/drive` is the endpoint way to drive (a Twist for up to 10 s, then zeros; `dryRun` sends nothing).

**Renamed from dim-live-viewer.** GitHub redirects the old URL. An install under the new name starts from the old
install's settings (`settings.json` is copied from `~/.dimos/data/apps/dim-live-viewer/`), and recordings keep going to
Desktop's `live-viewer` recordings folder if it exists (else `controller`). Setting keys keep their `lv.` prefix.

## What it shows

Every dimos topic is `dimos/<topic>/<message type>` on zenoh, so the key says how to draw it. Each message type has a
layer (one file in `frontend/src/layers/`), and each layer places what it draws by its header's `frame_id` through the
TF tree (`/tf`, `/tf_static`) into the fixed frame (auto: `world`, `map`, `odom`, ...). Data whose frame has no TF path
to the fixed frame is not drawn; the layer list says why.

| message type | layer |
| --- | --- |
| `sensor_msgs.PointCloud2` | points or voxels, colored by height / intensity / distance / solid, latest scan or accumulated |
| `nav_msgs.Odometry`, `geometry_msgs.PoseStamped`, `PoseWithCovarianceStamped` | pose axes + the driven path (bounded) |
| `nav_msgs.Path` | thick line |
| `nav_msgs.LineSegments3D` | node/edge graph, edges colored by weight |
| `geometry_msgs.PoseArray` | an arrow per pose |
| `visualization_msgs.Marker`, `MarkerArray` | arrows, cubes, spheres, cylinders, line strips/lists, cube/sphere lists, points, text, triangles |
| `vision_msgs.Detection3DArray`, `Detection3D`, `BoundingBox3DArray` | wireframe boxes with "class score" labels |
| `visualization_msgs.EntityMarkers`, `geometry_msgs.PointStamped` | labeled points |
| `nav_msgs.OccupancyGrid` | costmap / map plane |
| `tf2_msgs.TFMessage` | frame axes, names and parent links |
| `sensor_msgs.Image`, `CompressedImage` | camera panels; optionally projected into 3D (frustum + picture, from `CameraInfo`) |
| `vision_msgs.Detection2DArray`, `Detection2D`, `BoundingBox2DArray` | boxes over a camera panel |

Point clouds are GL point sprites, never meshes. The styles (Settings → Rendering for the default, each cloud's
settings to override): **Glow** (default: soft gaussian splats fading into the background with distance), **Cubes**
(MemWorld's: snaps each point to a grid and ray-casts an axis-aligned cube inside the sprite), **Spheres** (MemWorld's
lit balls) and **Squares**. Over 3M points a glow cloud draws a stable random subset, and if frames stay over 16 ms
the viewer switches glow to cubes and says so in the top bar. Coloring is a gradient lookup in the shader; scans stream into preallocated GPU buffers (a ring when
accumulating, aged out in the shader), so a new scan costs one partial buffer upload. The view only redraws when
something changed. Settings → Stats shows fps, CPU per frame and bridge-to-screen latency.

## Cameras

One camera panel opens on the profile's preferred camera; `+` adds more, each with its own topic and an optional 2D
detection overlay. A panel's ⤢ makes it fullscreen and turns the 3D view into a picture-in-picture (⤢ there swaps back).

## Driving

Driving is **off until armed** (the ARM button, or `POST api/drive/arm`). Arming is held by the backend: one switch for
every open page and the agent, shown on each, and a restart comes up disarmed. Escape or hiding the page disarms, and
disarming stops the robot. Armed, W/S drive, A/D turn, Q/E strafe (per the robot profile), Shift doubles linear speed
and halves turning, Space stops (the agent's command too). Linear and angular speeds are in the Drive panel. Commands go
straight to `dimos/<topic>/geometry_msgs.Twist` through Desktop's bridge with a deadman: if the page goes quiet or
disconnects, the bridge sends a zero Twist. Nothing is sent while nobody steers (a release is followed by a second of
zeros, then silence), so a parked browser never drowns out other teleop. The topic picker lists the Twist inputs of the
running blueprint (from Desktop's `/dimos/` API) and any Twist on the bridge; the default is the profile's first one
present, else `tele_cmd_vel`, else `cmd_vel`.

The agent drives with `POST api/drive` (refused while disarmed, except `dryRun`); the drive HUD shows its command, and
"dry run · nothing sent" for a dry run.

On a phone the panels become a bottom sheet and driving moves to on-screen sticks (left: drive and turn; right: strafe,
or up/down for a profile with a vertical axis), with FAST and STOP buttons.

## Costmap

`nav_msgs.OccupancyGrid` topics (e.g. `global_costmap`) draw as a plane under the robot, with its pose and the planned
path; Settings → Top-down (or `POST api/camera {action: "topDown"}`) gives the flat map view the old Controller
had in its map panel.

## Recording

The Record panel writes an mcap with the chosen topics (rpc topics are grouped and off by default; choices are
remembered, and topics that appear mid-recording join it: the backend finds them, so `POST api/recorder/start` with no
keys records the same set). Known types are written as ROS 2 CDR so Foxglove opens the
file; images can be re-encoded (png / jpeg xl lossless, webp, jpeg); anything else is kept as raw LCM bytes with its
type name. Files land in Desktop's shared recordings folder, under `controller/` (`live-viewer/` if that exists from
before the rename), else in the app's `DIMOS_APP_DATA/recordings`; the panel lists them with size, age, download, copy
path and delete.

The running dimos's own logs go into the same file. When recording starts the backend asks Desktop where they are
(`GET /dimos/runs`: each run's `log_dir`; on newer Desktops `GET /dimos/paths` as a fallback) and the backend tails
every `*.jsonl` there, new lines only (plus new files, runs that start mid-recording, truncation). Each line becomes a
`foxglove.Log` (JSON) on `/dimos/logs/<file stem>` (e.g. `/dimos/logs/main`), stamped with the line's own time, so
Foxglove's Log panel shows it; the original record is kept whole in its `fields` key (and the file in `source`).

## Location labels

Right-click the 3D view → **Label this location…** pins a text label at the clicked point (the nearest cloud point
under the cursor, else a mesh such as the map, else the ground plane), as a position in the fixed frame. Labels last for
the session, show in every open viewer, and are removed from the same menu. While a recording runs, every add and
remove (and the labels already made when it starts) is written to `/labels` as `dimos.LocationLabel` (JSON:
`timestamp`, `frame_id`, `id`, `label`, `action` add/delete, `pose` with position and orientation) and to
`/labels/scene` as a `foxglove.SceneUpdate` so Foxglove's 3D panel shows them.

## Fork this for your robot

Everything robot-specific is in **one file**, a profile under `frontend/src/profile/`: which frame is the robot, which
Twist topics to prefer, speeds, what each key does, and extra controls (sliders and buttons that publish a message).
`src/core/` (bridge, TF, renderer, drive loop, recorder) never needs to change.

1. Copy `frontend/src/profile/go2.ts` to `frontend/src/profile/my_robot.ts`, rename it, and list it first in
   `frontend/src/profile/index.ts` (the first profile is the default; Settings → Robot switches).
2. Edit it. For example `r1.ts` adds a torso height slider, stepped with R/F:

```ts
keys: {
    ...groundKeys,
    KeyR: { control: "torso_height", step: 0.02 },
    KeyF: { control: "torso_height", step: -0.02 },
},
controls: [{
    kind: "slider", id: "torso_height", label: "Torso height",
    topic: "/torso_height", type: "std_msgs.Float32",     // any dimos message type: fields as in its LCM schema
    min: 0, max: 0.4, step: 0.01, initial: 0.2, unit: "m",
    message: (value) => ({ data: value }),
}],
```

and `drone.ts` makes Q/E change altitude instead of strafing:

```ts
keys: { ...groundKeys, KeyQ: { axis: "vertical", value: -1 }, KeyE: { axis: "vertical", value: 1 } },
```

A profile can also replace how the axes become a Twist (`drive.twist`), e.g. for an arm or a robot that steers
differently. Controls only publish while drive is armed.

**A new message type** is one file too: copy the closest layer in `frontend/src/layers/` (e.g. `path.tsx`), change its
`types` and drawing, and import it in `layers/index.ts`. A layer registered later for the same type wins, so a fork can
also override a built-in one. Messages decode with the LCM schemas in `src/core/lcm/schemas.json` (every dimos_lcm
type; regenerate with `deno run -A tools/gen_lcm_schemas.ts <dimos_lcm/lcm_files>`).

## Develop

```sh
cd frontend && npm install && npm run dev      # vite on :5173, proxied to a Desktop on :7077 (DESKTOP_URL)
npm run typecheck && npm test                  # types; LCM decoder tests (deno)
cd ../server && cargo test                     # every endpoint; the recorder and driving over zenoh on loopback
deno task check-endpoints [--write]            # dimos.yaml's agent: = the served agent.json
nix build .#dimosApp                           # what Desktop builds: bin/dimos-app-server serving the page
```

`server/` is the app's `dimos-app-server` (Desktop's app contract): it serves the built page and every endpoint
under `/apps/<name>/`, and talks zenoh itself only to record, find topics and drive. The page reaches Desktop's zenoh-web bridge at
`../../zenoh-web`; its client is vendored at the commit Desktop embeds (`frontend/src/vendor/zenoh_web`, 0.4.1).
