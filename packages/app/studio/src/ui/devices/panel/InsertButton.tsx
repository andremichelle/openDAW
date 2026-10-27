import css from "./InsertButton.sass?inline"
import {Exec} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "InsertButton")

export const InsertButton = ({onClick}: { onClick: Exec }): HTMLElement => (
    <div className={className} title="Add a device here" onclick={onClick}>
        <Icon symbol={IconSymbol.Add}/>
    </div>
)
