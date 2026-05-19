import css from "./EditorLoadFailure.sass?inline"
import {Exec} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "EditorLoadFailure")

type Construct = {
    reason: unknown
    retry: Exec
}

export const EditorLoadFailure = ({reason, retry}: Construct) => (
    <div className={className}>
        <p className="headline">Failed to load the editor.</p>
        <p className="reason">{String(reason)}</p>
        <div className="actions">
            <button type="button" onclick={retry}>Retry</button>
        </div>
    </div>
)
