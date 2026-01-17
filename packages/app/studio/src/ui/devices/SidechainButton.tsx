import css from "./SidechainButton.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Option} from "@opendaw/lib-std"
import {Address, BoxEditing, PointerField} from "@opendaw/lib-box"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {LabeledAudioOutput, RootBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"

const className = Html.adoptStyleSheet(css, "SidechainButton")

type Construct = {
    editing: BoxEditing
    rootBoxAdapter: RootBoxAdapter
    sideChain: PointerField<Pointers.SideChain>
}

export const SidechainButton = ({sideChain, rootBoxAdapter, editing}: Construct) => {
    const createSideChainMenu = (parent: MenuItem) => {
        const isSelected = (address: Address) =>
            sideChain.targetAddress.mapOr(other => other.equals(address), false)
        const createSelectableItem = (output: LabeledAudioOutput): MenuItem => {
            if (output.children().nonEmpty()) {
                return MenuItem.default({label: output.label})
                    .setRuntimeChildrenProcedure(subParent =>
                        output.children().ifSome(children => {
                            for (const child of children) {
                                subParent.addMenuItem(createSelectableItem(child))
                            }
                        }))
            }
            return MenuItem.default({
                label: output.label,
                checked: isSelected(output.address)
            }).setTriggerProcedure(() => editing.modify(() =>
                sideChain.targetAddress = Option.wrap(output.address)))
        }
        sideChain.targetAddress.ifSome(() =>
            parent.addMenuItem(MenuItem.default({label: "Remove Sidechain"})
                .setTriggerProcedure(() => editing.modify(() =>
                    sideChain.targetAddress = Option.None))))
        parent.addMenuItem(MenuItem.header({label: "Tracks", icon: IconSymbol.OpenDAW, color: Colors.orange}))
        for (const output of rootBoxAdapter.labeledAudioOutputs()) {
            parent.addMenuItem(createSelectableItem(output))
        }
    }
    return (
        <MenuButton onInit={button => {
            button.classList.add(className)
            sideChain.catchupAndSubscribe(pointer =>
                button.classList.toggle("has-source", pointer.nonEmpty()))
        }} root={MenuItem.root().setRuntimeChildrenProcedure(createSideChainMenu)}
                    appearance={{tinyTriangle: true}}>Sidechain</MenuButton>
    )
}