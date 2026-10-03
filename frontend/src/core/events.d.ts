export const EVENTS_PATH: string
export function appEvents(
    onEvent: (event: any) => void,
    options?: { path?: string; query?: Record<string, string>; onOpen?: () => void; onClose?: (info: { wasOpen: boolean }) => void },
): () => void
