import css from "./Toast.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {Icon} from "@/ui/components/Icon.tsx"

const className = Html.adoptStyleSheet(css, "Toast")

const LONG_TEXT_THRESHOLD = 60

export const Toast = ({text, icon}: {text: string, icon: IconSymbol}): HTMLElement => {
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={icon}/>
            <span>{text}</span>
        </div>
    )
    const seconds = text.length > LONG_TEXT_THRESHOLD ? 5 : 2
    Wait.timeSpan(TimeSpan.seconds(seconds))
        .then(() => element.classList.add("leaving"))
        .then(() => Wait.event(element, "transitionend"))
        .then(() => element.remove())
    return element
}