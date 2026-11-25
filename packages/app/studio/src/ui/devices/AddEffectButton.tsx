import css from "./AddEffectButton.sass?inline"
import {Exec, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"

const className = Html.adoptStyleSheet(css, "AddEffectButton")

type Construct = {
    lifecycle: Lifecycle
    onClick: Exec
}

export const AddEffectButton = ({lifecycle, onClick}: Construct) => (
    <div className={className}>
        <Button lifecycle={lifecycle} onClick={() => onClick()} appearance={{color: Colors.shadow, cursor: "pointer"}}>
            <span>Add Effect</span> <Icon symbol={IconSymbol.Add}/>
        </Button>
    </div>
)
