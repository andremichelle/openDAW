import css from "./ModulatorSourceMenu.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Editing, Lifecycle, Option} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {LabeledAudioOutput, ModulatorMode, RootBoxAdapter, VocoderDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {MenuButton} from "@/ui/components/MenuButton"

const className = Html.adoptStyleSheet(css, "ModulatorSourceMenu")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    rootBoxAdapter: RootBoxAdapter
    adapter: VocoderDeviceBoxAdapter
}

const parseMode = (raw: string): ModulatorMode => {
    switch (raw) {
        case "noise-white":
        case "noise-pink":
        case "noise-brown":
        case "self":
        case "external":
            return raw
        default:
            return "noise-pink"
    }
}

const isDefaultMode = (mode: ModulatorMode): boolean => mode === "noise-pink"

export const ModulatorSourceMenu = ({lifecycle, editing, rootBoxAdapter, adapter}: Construct) => {
    const {box} = adapter
    const createMenu = (parent: MenuItem) => {
        const mode = parseMode(box.modulatorSource.getValue())

        const setMode = (next: ModulatorMode, sideChainTarget: Option<Address>) =>
            editing.modify(() => {
                box.modulatorSource.setValue(next)
                box.sideChain.targetAddress = sideChainTarget
            })

        parent.addMenuItem(MenuItem.header({label: "Noise", icon: IconSymbol.OpenDAW, color: Colors.cream}))
        parent.addMenuItem(MenuItem.default({label: "White", checked: mode === "noise-white"})
            .setTriggerProcedure(() => setMode("noise-white", Option.None)))
        parent.addMenuItem(MenuItem.default({label: "Pink", checked: mode === "noise-pink"})
            .setTriggerProcedure(() => setMode("noise-pink", Option.None)))
        parent.addMenuItem(MenuItem.default({label: "Brown", checked: mode === "noise-brown"})
            .setTriggerProcedure(() => setMode("noise-brown", Option.None)))
        parent.addMenuItem(MenuItem.default({separatorBefore: true, label: "Self", checked: mode === "self"})
            .setTriggerProcedure(() => setMode("self", Option.None)))

        parent.addMenuItem(MenuItem.header({label: "Tracks", icon: IconSymbol.OpenDAW, color: Colors.orange}))
        const isSelectedExternal = (address: Address) =>
            mode === "external" && box.sideChain.targetAddress.mapOr(other => other.equals(address), false)
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
                checked: isSelectedExternal(output.address)
            }).setTriggerProcedure(() => setMode("external", Option.wrap(output.address)))
        }
        for (const output of rootBoxAdapter.labeledAudioOutputs()) {
            parent.addMenuItem(createSelectableItem(output))
        }
    }
    return (
        <MenuButton onInit={button => {
            button.classList.add(className)
            lifecycle.own(box.modulatorSource.catchupAndSubscribe(() => {
                const mode = parseMode(box.modulatorSource.getValue())
                button.classList.toggle("has-source", !isDefaultMode(mode))
            }))
        }} root={MenuItem.root().setRuntimeChildrenProcedure(createMenu)}
                    appearance={{tinyTriangle: true}}>Modulator</MenuButton>
    )
}
