import css from "./RandomTab.sass?inline"
import {Editing, Lifecycle, MutableObservableValue, Selection} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {PropertyTable} from "@/ui/timeline/editors/notes/property/PropertyTable.tsx"
import {NoteGrouping} from "@/ui/timeline/editors/notes/NoteGrouping.ts"
import {NumberInput} from "@/ui/components/NumberInput.tsx"

const className = Html.adoptStyleSheet(css, "RandomTab")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    modifyContext: ObservableModifyContext<NoteModifier>
    selection: Selection<NoteEventBoxAdapter>
    seed: MutableObservableValue<number>
}

export const RandomTab = ({lifecycle, editing, modifyContext, selection, seed}: Construct) => {
    const status = Inject.value(NoteGrouping.status(selection))
    const update = lifecycle.own(deferNextFrame(() => status.value = NoteGrouping.status(selection)))
    lifecycle.ownAll(
        selection.subscribe({onSelected: update.request, onDeselected: update.request}),
        editing.subscribe(update.request))
    return (
        <div className={className}>
            <div className="status">{status}</div>
            <div className="row">
                <PropertyTable lifecycle={lifecycle} selection={selection} editing={editing} modifyContext={modifyContext}
                               rows={[["chance"]]}/>
                <div className="seed">
                    <span className="label">Seed</span>
                    <NumberInput lifecycle={lifecycle} model={seed} maxChars={6}/>
                </div>
            </div>
        </div>
    )
}
