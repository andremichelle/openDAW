import css from "./AudioEditor.sass?inline"
import {DefaultObservableValue, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {AudioEditorCanvas} from "@/ui/timeline/editors/audio/AudioEditorCanvas.tsx"
import {TimelineRange} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {EditorMenuCollector} from "@/ui/timeline/editors/EditorMenuCollector.ts"
import {AudioEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Html} from "@opendaw/lib-dom"
import {TransientMarkerEditor} from "@/ui/timeline/editors/audio/TransientMarkerEditor"
import {WarpMarkerEditor} from "@/ui/timeline/editors/audio/WarpMarkerEditor"
import {TransientMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {AudioEditorHeader} from "@/ui/timeline/editors/audio/AudioEditorHeader"
import {ppqn} from "@opendaw/lib-dsp"

const className = Html.adoptStyleSheet(css, "AudioEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    menu: EditorMenuCollector
    range: TimelineRange
    snapping: Snapping
    reader: AudioEventOwnerReader
}

export const AudioEditor = ({lifecycle, service, range, snapping, reader}: Construct) => {
    const hoverTransient = new DefaultObservableValue<Nullable<TransientMarkerBoxAdapter>>(null)
    const cursorModel = new DefaultObservableValue<Nullable<ppqn>>(null)
    return (
        <div className={className}>
            <Frag>
                <div className="label"><h5>Transients</h5></div>
                <div className="label"><h5>Warp Markers</h5></div>
                <AudioEditorHeader lifecycle={lifecycle}
                                   project={service.project}
                                   reader={reader}/>
            </Frag>
            <Frag>
                <TransientMarkerEditor lifecycle={lifecycle}
                                       project={service.project}
                                       range={range}
                                       snapping={snapping}
                                       reader={reader}
                                       hoverTransient={hoverTransient}/>
                <WarpMarkerEditor lifecycle={lifecycle}
                                  project={service.project}
                                  range={range}
                                  snapping={snapping}
                                  reader={reader}
                                  hoverTransient={hoverTransient}
                                  cursorModel={cursorModel}/>
                <AudioEditorCanvas lifecycle={lifecycle}
                                   project={service.project}
                                   range={range}
                                   snapping={snapping}
                                   reader={reader}
                                   cursorModel={cursorModel}/>
            </Frag>
        </div>
    )
}