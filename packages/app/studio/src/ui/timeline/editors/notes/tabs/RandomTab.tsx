import css from "./RandomTab.sass?inline"
import {Editing, Lifecycle, MutableObservableValue, Selection} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {NoteEventBoxAdapter, NoteEventFeatures} from "@opendaw/studio-adapters"
import {Colors} from "@opendaw/studio-enums"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {PropertyTable} from "@/ui/timeline/editors/notes/property/PropertyTable.tsx"
import {NoteGrouping} from "@/ui/timeline/editors/notes/NoteGrouping.ts"
import {Button} from "@/ui/components/Button.tsx"
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
    const appearance = {framed: true, color: Colors.dark, activeColor: Colors.green}
    return (
        <div className={className}>
            <PropertyTable lifecycle={lifecycle} selection={selection} editing={editing} modifyContext={modifyContext}
                           rows={[["chance"]]}/>
            <div className="row">
                <Button lifecycle={lifecycle}
                        onClick={() => NoteGrouping.group(editing, selection, NoteEventFeatures.GroupMode.PlayAll)}
                        appearance={{...appearance, tooltip: "Group: all notes play or none"}}>
                    <span>Play All</span>
                </Button>
                <Button lifecycle={lifecycle}
                        onClick={() => NoteGrouping.group(editing, selection, NoteEventFeatures.GroupMode.PlayOne)}
                        appearance={{...appearance, tooltip: "Group: one of the notes plays"}}>
                    <span>Play One</span>
                </Button>
                <Button lifecycle={lifecycle}
                        onClick={() => NoteGrouping.ungroup(editing, selection)}
                        appearance={appearance}>
                    <span>Ungroup</span>
                </Button>
            </div>
            <div className="status">{status}</div>
            <div className="row">
                <span className="label">Seed</span>
                <NumberInput lifecycle={lifecycle} model={seed} maxChars={6}/>
            </div>
        </div>
    )
}
