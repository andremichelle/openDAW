import css from "./Toast.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {Icon} from "@/ui/components/Icon.tsx"

const className = Html.adoptStyleSheet(css, "Toast")

export const Toast = ({text, icon}: {text: string, icon: IconSymbol}): HTMLElement => {
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={icon}/>
            <span>{text}</span>
        </div>
    )
    Wait.timeSpan(TimeSpan.seconds(3))
        .then(() => element.classList.add("leaving"))
        .then(() => Wait.event(element, "transitionend"))
        .then(() => element.remove())
    return element
}
