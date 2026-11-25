import css from "./LatencyWarning.sass?inline"
import {Exec} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "LatencyWarning")

type Construct = {
    anchor: HTMLElement
    message: string
    href: string
    label: string
    dismiss: Exec
}

export const LatencyWarning = ({anchor, message, href, label, dismiss}: Construct) => {
    const rect = anchor.getBoundingClientRect()
    return (
        <div className={className} style={{
            left: `${rect.left}px`,
            bottom: `${window.innerHeight - rect.top + 10}px`,
            backgroundColor: Colors.black.toString()
        }}>
            <Icon symbol={IconSymbol.Warning}/>
            <span>{message}</span>
            <span onclick={dismiss}>
                <a href={href} target="manuals">{label}</a>
            </span>
            <div className="close" onclick={dismiss}>✕</div>
        </div>
    )
}
