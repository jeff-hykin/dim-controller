// Settings' grouped look: a heading, the rows in one rounded card (label left, control right), a note under it; a folded
// group opens under its title. Rows are dimos-react Fields (inline) or SettingsLink buttons.
import type { ReactNode } from "react"
import { Disclosure } from "dimos-react"
import { Icon } from "./icons.tsx"

export function SettingsGroup({ title, note, children, ...rest }: { title?: ReactNode; note?: ReactNode; children: ReactNode; [data: `data-${string}`]: string }) {
    return (
        <section className="set-group" {...rest}>
            {title ? <h4 className="set-group-title">{title}</h4> : null}
            <div className="set-card">{children}</div>
            {note ? <div className="set-note">{note}</div> : null}
        </section>
    )
}

export function SettingsFold({ title, note, persistKey, children }: { title: ReactNode; note?: ReactNode; persistKey: string; children: ReactNode }) {
    return (
        <Disclosure className="set-group set-fold" title={title} defaultOpen={false} persistKey={persistKey}>
            <div className="set-card">{children}</div>
            {note ? <div className="set-note">{note}</div> : null}
        </Disclosure>
    )
}

/** a row that opens something (an overlay, a modal): its label, an optional trailing bit, then › */
export function SettingsLink({ label, icon, trailing, onClick, ...rest }: { label: ReactNode; icon?: string; trailing?: ReactNode; onClick: () => void; title?: string; [data: `data-${string}`]: string | undefined }) {
    return (
        <button type="button" className="set-row set-link" onClick={onClick} {...rest}>
            {icon ? <Icon name={icon} size={15} /> : null}
            <span className="set-link-label">{label}</span>
            {trailing}
            <span className="set-chevron" aria-hidden>›</span>
        </button>
    )
}
