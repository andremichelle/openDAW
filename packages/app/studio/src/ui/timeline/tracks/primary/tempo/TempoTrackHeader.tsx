import css from "./TempoTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {bpm} from "@opendaw/lib-dsp"
import {NumberInput} from "@/ui/components/NumberInput"

const className = Html.adoptStyleSheet(css, "TempoTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    bpmRange: [MutableObservableValue<bpm>, MutableObservableValue<bpm>]
}

export const TempoTrackHeader = ({lifecycle, bpmRange}: Construct) => {
    return (
        <div className={className}>
            <span>Tempo</span>
            <div className="bpm-range">
                <NumberInput lifecycle={lifecycle} model={bpmRange[0]}/>
                <hr/>
                <NumberInput lifecycle={lifecycle} model={bpmRange[1]}/>
            </div>
        </div>
    )
}