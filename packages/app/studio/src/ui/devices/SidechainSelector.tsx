import css from "./SidechainSelector.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Editing, Lifecycle} from "@opendaw/lib-std"
import {PointerField} from "@opendaw/lib-box"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {DeviceHost, RootBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"
import {Column} from "@/ui/devices/Column"
import {LKR} from "@/ui/devices/constants"
import {populateSidechainMenu, resolveSidechainLabel} from "@/ui/devices/SidechainButton"

const className = Html.adoptStyleSheet(css, "SidechainSelector")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    rootBoxAdapter: RootBoxAdapter
    sideChain: PointerField<Pointers.SideChain>
    deviceHost: DeviceHost
    label: string
}

export const SidechainSelector = ({lifecycle, editing, rootBoxAdapter, sideChain, deviceHost, label}: Construct) => {
    const sourceLabel: HTMLSpanElement = (<span className="source"/>)
    const root = MenuItem.root().setRuntimeChildrenProcedure(parent =>
        populateSidechainMenu(parent, {editing, rootBoxAdapter, sideChain, deviceHost}))
    const button: HTMLButtonElement = (
        <MenuButton root={root} appearance={{tooltip: "Select sidechain source"}}>
            <Icon symbol={IconSymbol.Add}/>
        </MenuButton>
    )
    lifecycle.own(sideChain.catchupAndSubscribe(pointer => {
        const source = resolveSidechainLabel(pointer, rootBoxAdapter, deviceHost)
        button.classList.toggle("has-source", pointer.nonEmpty())
        sourceLabel.textContent = source
        button.title = source.length > 0 ? source : "Select sidechain source"
    }))
    return (
        <div className={className}>
            <Column ems={LKR} color={Colors.cream}>
                <h5>{label}</h5>
                {button}
                {sourceLabel}
            </Column>
        </div>
    )
}
