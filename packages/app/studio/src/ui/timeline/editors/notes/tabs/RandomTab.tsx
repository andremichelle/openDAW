import css from "./RandomTab.sass?inline"
import {Editing, Lifecycle, Selection} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {NoteEventBoxAdapter} from "@opendaw/studio-adapters"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {PropertyTable} from "@/ui/timeline/editors/notes/property/PropertyTable.tsx"

const className = Html.adoptStyleSheet(css, "RandomTab")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    modifyContext: ObservableModifyContext<NoteModifier>
    selection: Selection<NoteEventBoxAdapter>
}

export const RandomTab = ({lifecycle, editing, modifyContext, selection}: Construct) => (
    <div className={className}>
        <PropertyTable lifecycle={lifecycle} selection={selection} editing={editing} modifyContext={modifyContext}
                       rows={[["chance"]]}/>
    </div>
)
