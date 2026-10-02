// Stroke icons (24-unit grid, currentColor).
const paths: Record<string, string> = {
    layers: "M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    camera: "M4 7h3l2-2h6l2 2h3v12H4V7Zm8 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
    drive: "M12 3v4m0 10v4M3 12h4m10 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    record: "M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z",
    tree: "M6 4v16M6 8h6m-6 8h6m6-12v4h-6m6 4v4h-6",
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3a7.4 7.4 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7.3 7.3 0 0 0-2.2-1.3L14.5 2h-5l-.3 2.5A7.3 7.3 0 0 0 7 5.8l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7.3 7.3 0 0 0 2.2 1.3l.3 2.5h5l.3-2.5a7.3 7.3 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3Z",
    fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5m11-5v5h-5",
    close: "M6 6l12 12M18 6 6 18",
    expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
    plus: "M12 5v14M5 12h14",
    target: "M12 2v4m0 12v4M2 12h4m12 0h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
    top: "M4 4h16v16H4zM12 8v8m-4-4h8",
    download: "M12 4v11m-5-5 5 5 5-5M5 20h14",
    trash: "M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
}

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={paths[name] ?? ""} />
        </svg>
    )
}
