import css from "./SnapSelector.sass?inline"
import {Lifecycle} from "@moises-ai/lib-std"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {createElement, Inject} from "@moises-ai/lib-jsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "SnapSelector")

type Construct = {
    lifecycle: Lifecycle
    snapping: Snapping
}

export const SnapSelector = ({lifecycle, snapping}: Construct) => {
    const snappingName = Inject.value(snapping.unit.name)
    lifecycle.own(snapping.subscribe(snapping => {snappingName.value = snapping.unit.name}))
    return (
        <div className={className}>
            <label>Snap</label>
            <MenuButton root={Snapping.createMenuRoot(snapping)}
                        appearance={{framed: true, color: Colors.gray, activeColor: Colors.bright}}>
                <label style={{minWidth: "5em"}}>{snappingName}<Icon symbol={IconSymbol.Dropdown}/></label>
            </MenuButton>
        </div>
    )
}