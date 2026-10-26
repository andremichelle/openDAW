import css from "./BackButton.sass?inline"
import {isDefined, Lifecycle} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {createElement, LocalLink, RouteLocation} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"

const className = Html.adoptStyleSheet(css, "BackButton")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const BackButton = ({lifecycle, service}: Construct) => {
    const href = service.hasProfile ? "/create" : "/"
    lifecycle.own(Surface.subscribeKeyboard("keydown", event => {
        if (event.code !== "Escape" || Events.isTextInput(event.target)
            || isDefined(document.querySelector("dialog[open]"))) {return}
        RouteLocation.get().navigateTo(href)
    }))
    return (
        <div className={className}>
            <LocalLink href={href}>
                <Icon symbol={IconSymbol.OpenDAW} style={{fontSize: "1.25em"}}/><span>GO BACK TO STUDIO</span>
            </LocalLink>
        </div>
    )
}