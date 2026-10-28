# Changing the UI

The frontend is React + three.js under `frontend/src`, compiled by Vite under Deno (no npm). Shared pieces (URDF,
gamepad, the 3D viewer, buttons, sliders) come from [dimos-react](https://github.com/jeff-hykin/dimos-react).

```
frontend/src/
  App.tsx            the page: the workspace (every panel), the bottom bar, the overlays
  core/              no React: the connection (transport.ts), the app object (app.ts), drive, tf, recorder, settings stores
  core/layers/       how a message type becomes something in the 3D view (registry.ts, manager.ts)
  layers/            one file per 3D layer type (pointcloud.tsx, path.tsx, ...), listed in layers/index.ts
  profile/           per robot type defaults (wheeled, dog, arm, ...)
  ui/                every panel, the bar, the settings drawer, the palette
  ui/workspace.ts    the layout, pure: where each panel sits (main view, left/right rail, floating; one at a time on a phone)
  ui/Workspace.tsx   the layout in React: useWorkspace, panel actions (show, main, collapse, popout, close)
  ui/Panel.tsx       the frame every panel shares: header, cog popover, tools row, body
  styles.css         all the CSS; colours come from Desktop's theme variables (--bg, --fg, --primary, ...)
```

## Add a panel

Panels are identified by an id. Fixed panels have a plain id (`map`, `scene`, `settings`, `tf`); panels that can be
many have `kind:n` ids (`camera:2`, `plot:1`) and their own list store. For a new fixed panel, say `battery`:

1. **Its home** in `ui/workspace.ts` `HOMES`: which rail it starts in, its rail weight, its floating size. Every key of
   `HOMES` is in `FIXED_PANELS`, which is how `App.tsx` and the layout learn it exists.
2. **Its name** in `ui/commands.ts` `panelTitle` (header, palette, phone list).
3. **Its kind** in `ui/panelCatalog.ts`: add it to `PanelKind`, `PANEL_KINDS` (title, an icon name from `ui/icons.tsx`, one-line about) and
   `kindOf`. That puts it in the Settings drawer's thumbnails and the phone's panel list. If it shows topics, teach
   `unshownStreams` which ones, so the thumbnail's badge counts streams no panel shows.
4. **The component**, e.g. `ui/BatteryPanel.tsx`, wrapped in the shared frame:
   ```tsx
   export function BatteryPanel({ app }: { app: ViewerApp }) {
       const { topics } = useStore(app.connection.status)
       return (
           <Panel id="battery" title={panelTitle("battery")} icon="signal" bodyClassName="panel-body" settings={() => <BatterySettings />}>
               ...
           </Panel>
       )
   }
   ```
   `Panel` places itself from the workspace by its `id`; don't position it yourself. `settings` is the header cog's
   popover. `keepMounted` keeps a heavy body (a canvas) alive while closed.
5. **Render it** in `App.tsx` next to the others, inside `<ContainCrash what="Battery">` so a crash only blanks that panel.
6. **Tests**: `test/workspace.test.ts` and `test/panelCatalog.test.ts` list the fixed panels in places; run them.

A panel that can be many (like cameras or plots) also needs its list in a `persistentStore` (see `ui/PlotPanel.tsx`:
`plotLayout`, `addPlot`, `removePlot`, `plotId`), its ids added to `ids` in `App.tsx`, and an `isX`/`xId` pair in
`ui/workspace.ts` with a home (`PLOT_HOME`).

Agents can also open and place panels without code: `PUT api/layout` and `POST api/layout/panel`.

## Get data into it

- Topics on the bus: `useStore(app.connection.status).topics` (`{ name, type, key }`).
- Subscribe: `app.connection.subscribe(key, options, (message) => ...)` returns the unsubscribe; call it from a
  `useEffect` and return it. Decode with `decode(type, message.bytes)` from `core/lcm/lcm.ts`. Options set the rate and the
  bandwidth priority (`maxHz`, `delivery: "latest" | "reliable"`, `bandwidthPriority`); with none, `core/bandwidth.ts`
  picks one by type (small state first, clouds, then maps and the robot model). Only subscribe while the panel is
  shown (a folded or closed panel should stop its stream).
- Publish: `app.connection.client.publisher(key, { priority, ... })` as in `core/drive.ts`.
- tf: `app.tf` (`lookup(child, parent)`, `has(frame)`); the fixed frame in use is `app.viewer.fixedFrame`.

## Settings

Settings live on the backend (`api/settings`, `lv.*` keys) so every page and the agent share them:
`persistentStore("lv.battery", { warnAt: 20 })` gives a `Store` you read with `useStore` and change with `.update()`.
Browser-only conveniences (a collapsed group) can use `readLocal` / `writeLocal`. The Settings panel
(`ui/SettingsPanel.tsx`) is built from `SettingsGroup` / `SettingsFold` / `SettingsLink` (`ui/SettingsGroup.tsx`); a
panel's own settings go in its cog popover, not there.

## A new thing in the 3D view

A message type becomes something in the 3D view through a layer type: copy the closest file in `layers/`, change
`id`, `label`, `types` (and `names` for a generic type), and import it in `layers/index.ts`. The LayerManager makes
one instance per matching topic while it's switched on; the instance's `update(frame)` runs every frame, `root` is
added to the scene for you, and `context.setStatus({ info, problem })` shows next to the layer in the list.

## Palette commands and keys

The `/` palette's commands are built in `ui/useCommands.ts` (`{ id, label, group, keys, run }`). Keys are routed in
`ui/keymap.ts` (pure, tested) and handled in `ui/useKeyboard.ts`; the `?` list reads `keymap.ts` too.

## Phone vs desktop

`useMobile()` (`ui/useMobile.ts`) decides. A phone shows one panel at a time and has no headers: its corner buttons
are `ui/PhoneCorners.tsx`, its sticks `ui/DriveHud.tsx`. Desktop has rails, floating panels and the bottom bar
(`ui/TopBar.tsx`). Check both widths. Some phone browsers are old (Chrome 108: no CSS `color-mix()`), so give a plain
colour before any `color-mix` line.

## Build, test, try it

```sh
cd frontend
deno task typecheck      # deno check src/
deno task test           # deno test test/  (pure logic: layout, keymap, bandwidth, ...)
deno task dev --base /apps/dim-controller/   # vite; with DESKTOP_URL=http://localhost:5555 to reach a Desktop
```

Without a backend the page still loads (no topics), which is enough to check layout and panels at phone and desktop
sizes. To try a change in a real Desktop without a release, build it and serve the frontend from disk: Desktop runs
the app with `CONTROLLER_FRONTEND=<dir>` pointing at a built `frontend/dist`. Releases are tags (`vX.Y.Z`), with the
version bumped in `dimos.yaml`, `server/Cargo.toml` and `server/Cargo.lock` together; a frontend dependency change
also needs `deno task update-hashes` from the repo root (the flake's hashes). `deno task test` there runs everything
(server tests, typecheck, frontend tests).

The backend's API (for agents and the page) is the endpoint table in `server/src/api.rs`, mirrored in `dimos.yaml`
`provides:` (`deno task check-endpoints` keeps them in step). Desktop refuses calls the installed `dimos.yaml` doesn't
list.
