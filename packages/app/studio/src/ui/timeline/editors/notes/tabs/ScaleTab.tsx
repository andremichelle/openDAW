import css from "./ScaleTab.sass?inline"
import {int, Lifecycle, MutableObservableValue, Selection} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {MidiKeys} from "@opendaw/lib-dsp"
import {MenuItem} from "@opendaw/studio-core"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {ScaleSelector} from "@/ui/timeline/editors/notes/pitch/ScaleSelector.tsx"
import {ScaleConfigurator} from "@/ui/timeline/editors/notes/pitch/ScaleConfigurator.tsx"

const className = Html.adoptStyleSheet(css, "ScaleTab")

type Construct = {
    lifecycle: Lifecycle
    selection: Selection<NoteEventBoxAdapter>
    scale: ScaleConfig
    followKey: MutableObservableValue<boolean>
}

export const ScaleTab = ({lifecycle, selection, scale, followKey}: Construct) => (
    <div className={className}>
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
        <Checkbox lifecycle={lifecycle}
                  model={followKey}
                  appearance={{color: Colors.dark, activeColor: Colors.green, tooltip: "Follow project key"}}>
            <Icon symbol={IconSymbol.Magnet}/>
        </Checkbox>
    </div>
)
