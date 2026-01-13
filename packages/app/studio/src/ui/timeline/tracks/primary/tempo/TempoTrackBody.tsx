import css from "./TempoTrackBody.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {isDefined, Lifecycle, MutableObservableValue, Terminator} from "@moises-ai/lib-std"
import {createElement, replaceChildren} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {ValueEditor} from "@/ui/timeline/editors/value/ValueEditor"
import {TempoValueContext} from "@/ui/timeline/tracks/primary/tempo/TempoValueContext"
import {TempoValueEventOwnerReader} from "@/ui/timeline/tracks/primary/tempo/TempoValueEventOwnerReader"
import {bpm} from "@moises-ai/lib-dsp"

const className = Html.adoptStyleSheet(css, "TempoTrackBody")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    bpmRange: [MutableObservableValue<bpm>, MutableObservableValue<bpm>]
}

export const TempoTrackBody = ({lifecycle, service, bpmRange}: Construct) => {
    const {project: {timelineBoxAdapter}, timeline: {range, snapping}} = service
    const editorLifecycle = lifecycle.own(new Terminator())
    return (
        <div className={className} onInit={element => {
            // Chrome bug: grid item collapses to 0 height when containing flex children
            lifecycle.own(Html.watchResize(element, () => {
                // This is a fix for a bug in Chrome where grid items collapsing to 0 height
                // To reproduce: Remove this code, open tempo-track, add one event, add an instrument, canvas goes black
                // Works fine in Firefox and Safari
                const parent = element.parentElement
                element.style.height = isDefined(parent) && element.clientHeight === 0 ? `${parent.clientHeight}px` : ""
            }))
            timelineBoxAdapter.tempoTrackEvents.catchupAndSubscribe(option => {
                editorLifecycle.terminate()
                option.match({
                    none: () => Html.empty(element),
                    some: () => {
                        const tempoValueContext = editorLifecycle.own(new TempoValueContext(timelineBoxAdapter, bpmRange))
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