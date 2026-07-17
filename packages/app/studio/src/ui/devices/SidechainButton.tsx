import css from "./SidechainButton.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Editing, Option} from "@opendaw/lib-std"
import {Address, PointerField} from "@opendaw/lib-box"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioCompositeAdapter, AudioEffectCompositeCellBoxAdapter, DeviceHost, LabeledAudioOutput, RootBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"

const className = Html.adoptStyleSheet(css, "SidechainButton")

type Construct = {
    editing: Editing
    rootBoxAdapter: RootBoxAdapter
    sideChain: PointerField<Pointers.SideChain>
    // The host of the device this button configures, so the picker can offer the INPUT of any composite this
    // device sits inside — a source only its OWN nested devices should be able to tap.
    deviceHost?: DeviceHost
}

export const SidechainButton = ({sideChain, rootBoxAdapter, editing, deviceHost}: Construct) => {
    const createSideChainMenu = (parent: MenuItem) => {
        const isSelected = (address: Address) =>
            sideChain.targetAddress.mapOr(other => other.equals(address), false)
        // Every composite this device is nested inside, innermost first. A device in entry A of composite C
        // may sidechain off C's INPUT (the signal entering C), and off an OUTER composite's input if C nests.
        const enclosingComposites = (): ReadonlyArray<AudioCompositeAdapter> => {
            const result: Array<AudioCompositeAdapter> = []
            let host: DeviceHost | undefined = deviceHost
            while (host instanceof AudioEffectCompositeCellBoxAdapter) {
                const composite = host.compositeDevice()
                result.push(composite)
                host = composite.deviceHost()
            }
            return result
        }
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
        // Scoped source: the input of each composite this device is inside. Offered ONLY here, so a device
        // outside the composite never sees it — the whole point of the input tap (its buffer identity survives
        // replacing the plugin before the composite, so the detection follows the live input).
        const composites = enclosingComposites()
        if (composites.length > 0) {
            parent.addMenuItem(MenuItem.header({label: "Composite Input", icon: IconSymbol.OpenDAW, color: Colors.blue}))
            for (const composite of composites) {
                const address = composite.inputField.address
                parent.addMenuItem(MenuItem.default({
                    label: `${composite.labelField.getValue()} Input`,
                    checked: isSelected(address)
                }).setTriggerProcedure(() => editing.modify(() =>
                    sideChain.targetAddress = Option.wrap(address))))
            }
        }
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