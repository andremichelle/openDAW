import css from "./AbsoluteUnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle, Terminator, TimeSpan} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "AbsoluteUnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const AbsoluteUnitDisplay = ({lifecycle, service}: Construct) => {
    const timeUnits = ["Hours", "Minutes", "Seconds", "Milliseconds"]
    const timeUnitIndex = new DefaultObservableValue(2)
    const hoursUnitString = new DefaultObservableValue("1")
    const minutesUnitString = new DefaultObservableValue("01")
    const secondsUnitString = new DefaultObservableValue("01")
    const millisecondsUnitString = new DefaultObservableValue("1")
    const unitDisplays = [
        <UnitDisplay lifecycle={lifecycle} name="hour" value={hoursUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="min" value={minutesUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="sec" value={secondsUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="ms" value={millisecondsUnitString} numChars={3}/>
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
                            const seconds = tempoMap.ppqnToSeconds(position.getValue())
                            const timeSpan = TimeSpan.seconds(seconds)
                            hoursUnitString.setValue(timeSpan.absHours().toFixed(0).padStart(2, "0"))
                            minutesUnitString.setValue(timeSpan.absMinutes().toFixed(0).padStart(2, "0"))
                            secondsUnitString.setValue(timeSpan.absSeconds().toFixed(0).padStart(2, "0"))
                            millisecondsUnitString.setValue((timeSpan.millis() % 1000.0).toFixed(0).padStart(3, "0"))
                        }
                        subscription.ownAll(
                            service.engine.position.catchupAndSubscribe(update),
                            timelineBoxAdapter.catchupAndSubscribeTempoAutomation(update)
                        )
                    } else {
                        hoursUnitString.setValue("00")
                        minutesUnitString.setValue("00")
                        secondsUnitString.setValue("00")
                        millisecondsUnitString.setValue("000")
                    }
                }),
                timeUnitIndex.catchupAndSubscribe(owner =>
                    unitDisplays.forEach((element, index) => element.classList.toggle("hidden", index > owner.getValue()))),
                ContextMenu.subscribe(element, (collector: ContextMenu.Collector) => collector.addItems(MenuItem.default({
                    label: "Units"
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...timeUnits.map((_, index) => MenuItem.default({
                        label: timeUnits.slice(0, index + 1).join(" > "),
                        checked:
                            index === timeUnitIndex.getValue()
                    }).setTriggerProcedure(() => timeUnitIndex.setValue(index)))
                ))))
            )
        }}>{unitDisplays}</div>
    )
}