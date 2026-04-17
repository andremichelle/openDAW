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

export const ModulatorSourceMenu = ({lifecycle, editing, rootBoxAdapter, adapter}: Construct) => {
    const {box} = adapter
    const createMenu = (parent: MenuItem) => {
        const mode = parseMode(box.modulatorSource.getValue())
        const setMode = (next: ModulatorMode, sideChainTarget: Option<Address>) =>
            editing.modify(() => {
                box.modulatorSource.setValue(next)
                box.sideChain.targetAddress = sideChainTarget
            })
        parent.addMenuItem(MenuItem.header({label: "Noise", icon: IconSymbol.OpenDAW, color: Colors.orange}))
        parent.addMenuItem(MenuItem.default({label: "White", checked: mode === "noise-white"})
            .setTriggerProcedure(() => setMode("noise-white", Option.None)))
        parent.addMenuItem(MenuItem.default({label: "Pink", checked: mode === "noise-pink"})
            .setTriggerProcedure(() => setMode("noise-pink", Option.None)))
        parent.addMenuItem(MenuItem.default({label: "Brown", checked: mode === "noise-brown"})
            .setTriggerProcedure(() => setMode("noise-brown", Option.None)))
        parent.addMenuItem(MenuItem.default({separatorBefore: true, label: "Self Modulation", checked: mode === "self"})
            .setTriggerProcedure(() => setMode("self", Option.None)))
        parent.addMenuItem(MenuItem.header({label: "Tracks", icon: IconSymbol.OpenDAW, color: Colors.blue}))
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
    const resolveLabel = (): string => {
        const mode = parseMode(box.modulatorSource.getValue())
        switch (mode) {
            case "noise-white":
                return "White"
            case "noise-pink":
                return "Pink"
            case "noise-brown":
                return "Brown"
            case "self":
                return "Self"
            case "external": {
                let label = "External"
                box.sideChain.targetVertex.ifSome(vertex => {
                    for (const output of rootBoxAdapter.labeledAudioOutputs()) {
                        if (output.address.equals(vertex.box.address)) {
                            label = output.label
                            return
                        }
                    }
                })
                return label
            }
        }
    }
    return (
        <MenuButton onInit={button => {
            button.classList.add(className)
            const update = () => button.textContent = resolveLabel()
            lifecycle.ownAll(
                box.modulatorSource.catchupAndSubscribe(update),
                box.sideChain.catchupAndSubscribe(update)
            )
        }} root={MenuItem.root().setRuntimeChildrenProcedure(createMenu)}>Pink</MenuButton>
    )
}
