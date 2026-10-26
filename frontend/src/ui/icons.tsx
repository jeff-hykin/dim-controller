// Icons: dimos-react's shared dimOS line icons, plus this app's own workspace ones (by `path`).
import { Icon as LibIcon } from "dimos-react"

const OWN_ICON_PATHS: Record<string, string> = {
    // the gear: eight even teeth around the hole (dimos-react's is lopsided)
    settings: "M10.32 5 L10.5 2.52 L13.5 2.52 L13.68 5 L15.76 5.86 L17.64 4.23 L19.77 6.36 L18.14 8.24 L19 10.32 L21.48 10.5 L21.48 13.5 L19 13.68 L18.14 15.76 L19.77 17.64 L17.64 19.77 L15.76 18.14 L13.68 19 L13.5 21.48 L10.5 21.48 L10.32 19 L8.24 18.14 L6.36 19.77 L4.23 17.64 L5.86 15.76 L5 13.68 L2.52 13.5 L2.52 10.5 L5 10.32 L5.86 8.24 L4.23 6.36 L6.36 4.23 L8.24 5.86Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    // pop out (float): a box with an arrow leaving it
    float: "M18 14v6H4V6h6 M14 4h6v6 M20 4l-9 9",
    // a frame with a picture filling its middle (make this the main view)
    main: "M3 4h18v16H3z M7 8h10v8H7z",
    // a frame with a rail down its left side (dock into a rail)
    dock: "M3 4h18v16H3z M9 4v16 M5 8h2 M5 11h2",
    // a camera's fit: |<->|, the whole width fits between the edges (no frame, so it can't read as "main view")
    fit: "M3 5v14M21 5v14 M6 12h12M9 9l-3 3 3 3M15 9l3 3-3 3",
    // a camera's fill: crop marks around a picture that runs past them
    fill: "M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4 M7 8h10v8H7z",
    // a camera's undistort: a barrel-bent grid pulled straight
    undistort: "M4 4h16v16H4z M4 12h16M12 4v16 M7 4q-2 8 0 16M17 4q2 8 0 16",
    // the map's "fit the whole map": a magnifier over a frame
    // three dots in a row (more actions)
    more: "M5 12h.01 M12 12h.01 M19 12h.01",
    // a robot arm: base, two links, an open gripper
    arm: "M4 21h8 M8 21v-4 M8 17l4-7 M12 10l6-3 M18 7l3-2 M18 7l2 3",
    // a line chart on its axes (a Plot panel)
    plot: "M3 3v18h18 M7 15l4-5 3 3 5-7",
    "fit-map": "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z M15.5 15.5 20 20 M8 8.5h5v4H8z",
    // the map's height slice: kept above the followed frame (an arrow up off a line), and below it
    "slice-above": "M4 20h16 M12 16V4 M7 9l5-5 5 5",
    "slice-below": "M4 4h16 M12 8v12 M7 15l5 5 5-5",
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
    return <LibIcon name={name} path={OWN_ICON_PATHS[name]} size={size} />
}
