// A quiet one-line note over the view's corner when the TF tree is broken (core/tfCheck.ts); nothing when it's fine.
// Clicking it opens the TF tab, where the frames involved are marked.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Icon } from "./icons.tsx"

export function TfFootnote({ app, onOpen }: { app: ViewerApp; onOpen: () => void }) {
    const { issues } = useStore(app.tfIssues)
    if (!issues.length) {
        return null
    }
    const more = issues.length > 1 ? ` · +${issues.length - 1} more` : ""
    return (
        <button type="button" className="tf-footnote" data-testid="tf-footnote" title={issues.map((issue) => `${issue.summary}: ${issue.detail}`).join("\n")} onClick={onOpen}>
            <Icon name="warn" size={13} />
            <span>TF: {issues[0].summary}{more}</span>
        </button>
    )
}
