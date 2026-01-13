import css from "./TapButton.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {PPQN} from "@moises-ai/lib-dsp"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "TapButton")

type Construct = {
    service: StudioService
}

// TODO when engine is running, try to approach the actual signature

export const TapButton = ({service}: Construct) => {
    const {projectProfileService} = service
    let lastTapTime = performance.now()
    let lastMeasuredBpm = 0.0
    let lastFilteredBpm = 0.0
    return (
        <div className={className} onpointerdown={(event) => {
            const profileOption = projectProfileService.getValue()
            const tapTime = event.timeStamp
            const differenceInSeconds = (tapTime - lastTapTime) / 1000.0
            const denominator = profileOption.match({
                none: () => 4,
                some: ({project: {timelineBox: {signature: {denominator}}}}) => denominator.getValue()
            })
            const quarter = PPQN.fromSignature(1, denominator)
            const measuredBpm = PPQN.secondsToBpm(differenceInSeconds, quarter)
            const ratio = lastMeasuredBpm / measuredBpm
            const percentOff = Math.abs(Math.log10(ratio)) * 100.0
            if (percentOff > 5.0) {
                // reset value
                lastFilteredBpm = measuredBpm
            } else {
                // smooth exponentially
                const coeff = 0.125
                lastFilteredBpm *= Math.pow(measuredBpm / lastFilteredBpm, coeff)
                profileOption
                    .ifSome(({project: {editing, timelineBox: {bpm}}}) =>
                        editing.modify(() => bpm.setValue(lastFilteredBpm), false))
            }
            lastTapTime = tapTime
            lastMeasuredBpm = measuredBpm
        }}>TAP</div>
    )
}