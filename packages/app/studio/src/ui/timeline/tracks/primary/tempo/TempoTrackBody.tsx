import css from "./TempoTrackBody.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {ValueEditor} from "@/ui/timeline/editors/value/ValueEditor"
import {TempoValueContext} from "@/ui/timeline/tracks/primary/tempo/TempoValueContext"
import {TempoValueEventOwnerReader} from "@/ui/timeline/tracks/primary/tempo/TempoValueEventOwnerReader"

const className = Html.adoptStyleSheet(css, "TempoTrackBody")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrackBody = ({lifecycle, service}: Construct) => {
    const {project: {timelineBoxAdapter}, timeline: {range, snapping}} = service
    const editorLifecycle = lifecycle.own(new Terminator())
    return (
        <div className={className} onInit={element => {
            timelineBoxAdapter.tempoTrack.catchupAndSubscribe(option => {
                editorLifecycle.terminate()
                option.match({
                    none: () => Html.empty(element),
                    some: () => {
                        const tempoValueContext = new TempoValueContext(timelineBoxAdapter)
                        return replaceChildren(element, (
                            <ValueEditor lifecycle={editorLifecycle}
                                         service={service}
                                         range={range}
                                         snapping={snapping}
                                         context={tempoValueContext}
                                         eventMapping={tempoValueContext.valueMapping}
                                         reader={new TempoValueEventOwnerReader(timelineBoxAdapter)}/>
                        ))
                    }
                })
            })
        }}/>
    )
}