import css from "./BackButton.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {createElement, LocalLink} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "BackButton")

export const BackButton = ({service}: { service: StudioService }) => {
    return (
        <div className={className}>
            <LocalLink href={service.hasProfile ? "/create" : "/"}>
                <Icon symbol={IconSymbol.OpenDAW} style={{fontSize: "1.25em"}}/><span>GO BACK TO STUDIO</span>
            </LocalLink>
        </div>
    )
}