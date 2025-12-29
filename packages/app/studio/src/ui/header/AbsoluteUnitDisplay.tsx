import css from "./AbsoluteUnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {StudioService} from "@/service/StudioService"
import {SMPTE} from "@opendaw/lib-dsp"
import {Preferences} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "AbsoluteUnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const AbsoluteUnitDisplay = ({lifecycle, service}: Construct) => {
    const hoursUnitString = new DefaultObservableValue("1")
    const minutesUnitString = new DefaultObservableValue("01")
    const secondsUnitString = new DefaultObservableValue("01")
    const framesUnitString = new DefaultObservableValue("00")
    const subFramesUnitString = new DefaultObservableValue("00")
    const unitDisplays: ReadonlyArray<HTMLElement> = [
        <UnitDisplay lifecycle={lifecycle} name="hr" value={hoursUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="min" value={minutesUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="sec" value={secondsUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="fr" value={framesUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="sub" value={subFramesUnitString} numChars={2}/>
    ]
    const subscription = lifecycle.own(new Terminator())
    return (
        <div className={className} onInit={element => {
            lifecycle.ownAll(
                service.projectProfileService.catchupAndSubscribe(optProfile => {
                    subscription.terminate()
                    if (optProfile.nonEmpty()) {
                        const {project: {engine: {position}, tempoMap, timelineBoxAdapter}} = optProfile.unwrap()
                        const update = () => {
                            const ppqn = position.getValue()
                            const {
                                hours,
                                minutes,
                                seconds,
                                frames,
                                subframes
                            } = SMPTE.fromSeconds(tempoMap.ppqnToSeconds(ppqn), 25)
                            hoursUnitString.setValue(Math.abs(hours).toFixed(0).padStart(2, "0"))
                            minutesUnitString.setValue(Math.abs(minutes).toFixed(0).padStart(2, "0"))
                            secondsUnitString.setValue(Math.abs(seconds).toFixed(0).padStart(2, "0"))
                            framesUnitString.setValue(frames.toFixed(0).padStart(2, "0"))
                            subFramesUnitString.setValue(subframes.toFixed(0).padStart(2, "0"))
                        }
                        subscription.ownAll(
                            service.engine.position.catchupAndSubscribe(update),
                            timelineBoxAdapter.catchupAndSubscribeTempoAutomation(update)
                        )
                    } else {
                        hoursUnitString.setValue("00")
                        minutesUnitString.setValue("00")
                        secondsUnitString.setValue("00")
                        framesUnitString.setValue("00")
                        subFramesUnitString.setValue("00")
                    }
                }),
                Preferences.catchupAndSubscribe(enabled =>
                    element.classList.toggle("hidden", !enabled), "time-display", "absolute"),
                Preferences.catchupAndSubscribe(details => {
                    const maxIndex = details ? 4 : 1
                    unitDisplays.forEach((element, index) => element.classList.toggle("hidden", index > maxIndex))
                }, "time-display", "details")
            )
        }}>
            {unitDisplays[0]}
            {unitDisplays[1]}
            {unitDisplays[2]}
            {unitDisplays[3]}
            {unitDisplays[4]}
        </div>
    )
}