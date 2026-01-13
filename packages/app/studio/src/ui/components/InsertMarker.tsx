import css from "./InsertMarker.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {createElement} from "@moises-ai/lib-jsx"

const className = Html.adoptStyleSheet(css, "InsertMarker")

export const InsertMarker = () => {
    return (
        <div className={className}>
            <Icon symbol={IconSymbol.ArrayDown}/>
        </div>
    )
}