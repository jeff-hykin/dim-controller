// Settings' grouped look: a heading, the rows in one rounded card (label left, control right); a folded group opens
// under its title. Rows are dimos-react Fields (inline, a note as the Field's hint) or SettingsLink buttons: a row's
// note sits in that row, not under the group.
import type { ReactNode } from "react"
import { Disclosure } from "dimos-react"
import { Icon } from "./icons.tsx"

export function SettingsGroup({ title, children, ...rest }: { title?: ReactNode; children: ReactNode; [data: `data-${string}`]: string }) {
    return (
        <section className="set-group" {...rest}>
            {title ? <h4 className="set-group-title">{title}</h4> : null}
            <div className="set-card">{children}</div>
        </section>
    )
}

export function SettingsFold({ title, persistKey, children }: { title: ReactNode; persistKey: string; children: ReactNode }) {
    return (
        <Disclosure variant="card" className="set-group set-fold" title={title} defaultOpen={false} persistKey={persistKey}>
            <div className="set-card">{children}</div>
        </Disclosure>
    )
}

/** a row that opens something (an overlay, a modal): its label (a note under it), an optional trailing bit, then › */
export function SettingsLink({ label, note, icon, trailing, onClick, ...rest }: { label: ReactNode; note?: ReactNode; icon?: string; trailing?: ReactNode; onClick: () => void; title?: string; [data: `data-${string}`]: string | undefined }) {
    return (
        <button type="button" className="set-row set-link" onClick={onClick} {...rest}>
            {icon ? <Icon name={icon} size={15} /> : null}
            <span className="set-link-label">{label}{note ? <span className="set-row-note">{note}</span> : null}</span>
            {trailing}
            <span className="set-chevron" aria-hidden>›</span>
        </button>
    )
}
