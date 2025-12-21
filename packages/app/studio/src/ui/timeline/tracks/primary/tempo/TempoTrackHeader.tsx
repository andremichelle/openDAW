import css from "./TempoTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {clamp, Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {bpm} from "@opendaw/lib-dsp"
import {NumberInput} from "@/ui/components/NumberInput"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"
import {TempoRange} from "@opendaw/studio-adapters"

const className = Html.adoptStyleSheet(css, "TempoTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    bpmRange: [MutableObservableValue<bpm>, MutableObservableValue<bpm>]
}

const MinBpmPadding = 30

export const TempoTrackHeader = ({lifecycle, service, bpmRange}: Construct) => {
    return (
        <div className={className}>
            <span>Tempo</span>
            <div className="bpm-range">
                <Button lifecycle={lifecycle}
                        appearance={{cursor: "pointer", tooltip: "Reset visible range to fit all events"}}
                        onClick={() => {
                            service.project.timelineBoxAdapter.tempoTrack.ifSome(adapter => {
                                const [min, max] = adapter.events.asArray().reduce((range, event) => {
                                    range[0] = Math.min(event.value, range[0])
                                    range[1] = Math.max(event.value, range[1])
                                    return range
                                }, [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
                                if (Number.isFinite(min) && Number.isFinite(max)) {
                                    if (max - min < MinBpmPadding) {
                                        const center = (min + max) / 2
                                        const low = Math.max(TempoRange.min, center - MinBpmPadding / 2)
                                        bpmRange[0].setValue(low)
                                        bpmRange[1].setValue(low + MinBpmPadding)
                                    } else {
                                        bpmRange[0].setValue(Math.max(min - MinBpmPadding, TempoRange.min))
                                        bpmRange[1].setValue(Math.min(max + MinBpmPadding, TempoRange.max))
                                    }
                                }
                            })
                        }}>
                    <Icon symbol={IconSymbol.Compressor}/>
                </Button>
                <NumberInput lifecycle={lifecycle} model={bpmRange[0]}
                             step={1}
                             guard={{
                                 guard: (value: bpm): bpm =>
                                     clamp(Math.round(value), TempoRange.min, bpmRange[1].getValue() - MinBpmPadding)
                             }}/>
                <hr/>
                <NumberInput lifecycle={lifecycle} model={bpmRange[1]}
                             guard={{
                                 guard: (value: bpm): bpm =>
                                     clamp(Math.round(value), bpmRange[0].getValue() + MinBpmPadding, TempoRange.max)
                             }}/>
            </div>
        </div>
    )
}