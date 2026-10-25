// The 3D view menu's search (ui/ScenePanel.tsx): with more than a screenful of layer switches, a box narrows them to the
// topics whose name, type or group match every word typed.

/** the menu shows the search box once it has more switches than this */
export const FILTER_OVER = 10

/** Every whitespace-separated word of `query` is in one of `texts` (a topic's name, its type, its group label; any case). */
export function matchesQuery(query: string, ...texts: string[]): boolean {
    const haystack = texts.join(" ").toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}
