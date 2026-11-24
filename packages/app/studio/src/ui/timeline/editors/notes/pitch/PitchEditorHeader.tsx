import css from "./PitchEditorHeader.sass?inline"
import {Editing, Lifecycle, MutableObservableValue, Selection} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {RadioGroup} from "@/ui/components/RadioGroup.tsx"
import {ScaleConfig} from "@/ui/timeline/editors/notes/pitch/ScaleConfig.ts"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {BasicTab} from "@/ui/timeline/editors/notes/tabs/BasicTab.tsx"
import {RandomTab} from "@/ui/timeline/editors/notes/tabs/RandomTab.tsx"
import {ScaleTab} from "@/ui/timeline/editors/notes/tabs/ScaleTab.tsx"
import {SplitTab} from "@/ui/timeline/editors/notes/tabs/SplitTab.tsx"

const className = Html.adoptStyleSheet(css, "PitchEditorHeader")

export type NoteEditorTab = "basic" | "random" | "scale" | "split"

const TabLabels: ReadonlyArray<[NoteEditorTab, string]> =
    [["basic", "Basic"], ["random", "Random"], ["scale", "Scale"], ["split", "Split"]]

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    modifyContext: ObservableModifyContext<NoteModifier>
    selection: Selection<NoteEventBoxAdapter>
    scale: ScaleConfig
    followKey: MutableObservableValue<boolean>
    tab: MutableObservableValue<NoteEditorTab>
}

export const PitchEditorHeader = ({lifecycle, editing, modifyContext, selection, scale, followKey, tab}: Construct) => {
    const panels: ReadonlyArray<[NoteEditorTab, HTMLElement]> = [
        ["basic", <BasicTab lifecycle={lifecycle} editing={editing} modifyContext={modifyContext} selection={selection}/>],
        ["random", <RandomTab lifecycle={lifecycle} editing={editing} modifyContext={modifyContext} selection={selection}/>],
        ["scale", <ScaleTab lifecycle={lifecycle} selection={selection} scale={scale} followKey={followKey}/>],
        ["split", <SplitTab lifecycle={lifecycle} editing={editing} modifyContext={modifyContext} selection={selection}/>]
    ]
    lifecycle.own(tab.catchupAndSubscribe(owner => panels
        .forEach(([value, panel]) => panel.classList.toggle("active", value === owner.getValue()))))
    return (
        <div className={className}>
            <div className="tab-bar">
                <RadioGroup lifecycle={lifecycle}
                            model={tab}
                            className="tabs"
                            elements={TabLabels.map(([value, label]) => ({value, element: <span>{label}</span>}))}
                            appearance={{color: Colors.shadow, activeColor: Colors.dark}}/>
            </div>
            <div className="panels">{panels.map(([, panel]) => panel)}</div>
        </div>
    )
}