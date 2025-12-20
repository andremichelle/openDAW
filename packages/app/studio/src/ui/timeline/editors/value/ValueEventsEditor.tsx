import css from "./ValueEventsEditor.sass?inline"
import {Lifecycle, ValueMapping} from "@opendaw/lib-std"
import {StudioService} from "@/service/StudioService.ts"
import {createElement} from "@opendaw/lib-jsx"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {ValueEditor} from "@/ui/timeline/editors/value/ValueEditor.tsx"
import {ValueEditorHeader} from "@/ui/timeline/editors/value/ValueEditorHeader.tsx"
import {EditorMenuCollector} from "@/ui/timeline/editors/EditorMenuCollector.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {ParameterValueEditing} from "@/ui/timeline/editors/value/ParameterValueEditing.ts"
import {Html} from "@opendaw/lib-dom"
import {TimelineRange} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "ValueEventsEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    context: ParameterValueEditing
    menu: EditorMenuCollector
    range: TimelineRange
    snapping: Snapping
    mapping: ValueMapping<number>
    reader: ValueEventOwnerReader
}

export const ValueEventsEditor = ({lifecycle, service, context, range, snapping, mapping, reader}: Construct) => {
    return (
        <div className={className}>
            <ValueEditorHeader lifecycle={lifecycle}
                               service={service}
                               context={context}/>
            <ValueEditor lifecycle={lifecycle}
                         service={service}
                         range={range}
                         snapping={snapping}
                         mapping={mapping}
                         context={context}
                         reader={reader}/>
        </div>
    )
}