import css from "./PitchEditorHeader.sass?inline"
import {int, Lifecycle, Selection} from "@moises-ai/lib-std"
import {ScaleSelector} from "@/ui/timeline/editors/notes/pitch/ScaleSelector.tsx"
import {ScaleConfigurator} from "@/ui/timeline/editors/notes/pitch/ScaleConfigurator.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem} from "@moises-ai/studio-core"
import {MidiKeys} from "@moises-ai/lib-dsp"
import {Icon} from "@/ui/components/Icon.tsx"
import {createElement} from "@moises-ai/lib-jsx"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {NoteEventBoxAdapter} from "@moises-ai/studio-adapters"
import {IconSymbol} from "@moises-ai/studio-enums"
import {PropertyTable} from "@/ui/timeline/editors/notes/property/PropertyTable.tsx"
import {BoxEditing} from "@moises-ai/lib-box"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {Html} from "@moises-ai/lib-dom"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "PitchEditorHeader")

type Construct = {
    lifecycle: Lifecycle
    editing: BoxEditing
    modifyContext: ObservableModifyContext<NoteModifier>
    selection: Selection<NoteEventBoxAdapter>
    scale: ScaleConfig
}

export const PitchEditorHeader = ({lifecycle, editing, modifyContext, selection, scale}: Construct) => {
    return (
        <div className={className}>
            <Icon symbol={IconSymbol.Note} className="label"/>
            <div className="row">
                <ScaleSelector lifecycle={lifecycle} scale={scale}/>
                <ScaleConfigurator lifecycle={lifecycle} scale={scale}/>
                <MenuButton root={MenuItem.root()
                    .setRuntimeChildrenProcedure(parent => parent
                        .addMenuItem(MenuItem.default({label: "No Scale", checked: scale.isEmpty()})
                            .setTriggerProcedure(() => scale.reset()))
                        .addMenuItem(MenuItem.default({label: "From Selection", selectable: !selection.isEmpty()})
                            .setTriggerProcedure(() =>
                                scale.setBits(selection.selected().reduce((bits, event) => bits | 1 << (event.pitch % 12), 0))))
                        .addMenuItem(...MidiKeys.StockScales.map((predefinedScale: MidiKeys.PredefinedScale, index: int) =>
                            MenuItem.default({
                                label: predefinedScale.name,
                                checked: predefinedScale.equals(scale),
                                separatorBefore: index === 0
                            }).setTriggerProcedure(() => scale.setScale(predefinedScale)))))}
                            style={{minWidth: "0"}}
                            appearance={{color: Colors.dark}}
                            horizontal="right">
                    <Icon symbol={IconSymbol.FileList}/>
                </MenuButton>
            </div>
            <Icon symbol={IconSymbol.Table} className="label"/>
            <PropertyTable lifecycle={lifecycle} selection={selection} editing={editing} modifyContext={modifyContext}/>
        </div>
    )
}