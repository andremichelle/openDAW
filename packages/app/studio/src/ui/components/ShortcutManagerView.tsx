import css from "./ShortcutManagerView.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioShortcuts} from "@/service/StudioShortcuts"

const className = Html.adoptStyleSheet(css, "ShortcutManagerView")

type Construct = {
    lifecycle: Lifecycle
}

export const ShortcutManagerView = ({}: Construct) => {
    return (
        <div className={className}>
            <div className="shortcuts">
                {Object.entries(StudioShortcuts.Actions).map(([_key, value]) => (
                    <div className="shortcut">
                        <span>{value.description}</span>
                        <span>{value.keys.format()}</span>
                    </div>
                ))}
            </div>
        </div>
    )
}