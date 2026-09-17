import css from "./Toast.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Html} from "@opendaw/lib-dom"
import {TimeSpan} from "@opendaw/lib-std"
import {Wait} from "@opendaw/lib-runtime"
import {Icon} from "@opendaw/studio-icons"

const className = Html.adoptStyleSheet(css, "Toast")

const layer: HTMLElement = <div className="toasts"/>

export const ToastLayer = () => layer

export const toast = (text: string, icon: IconSymbol = IconSymbol.Notification): void => {
    const element: HTMLElement = (
        <div className={className}>
            <Icon symbol={icon}/>
            <span>{text}</span>
        </div>
    )
    layer.prepend(element)
    Wait.timeSpan(TimeSpan.seconds(2))
        .then(() => element.classList.add("leaving"))
        .then(() => Wait.event(element, "transitionend"))
        .then(() => element.remove())
}
