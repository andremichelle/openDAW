import css from "./MusicalUnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {PPQN} from "@opendaw/lib-dsp"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {ContextMenu} from "@/ui/ContextMenu"
import {MenuItem} from "@/ui/model/menu-item"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "MusicalUnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MusicalUnitDisplay = ({lifecycle, service}: Construct) => {
    // Bar, Bar/Beats, Bar/Beats/SemiQuaver, Bar/Beats/SemiQuaver/Ticks
    const timeUnits = ["Bar", "Beats", "SemiQuaver", "Ticks"]
    const timeUnitIndex = new DefaultObservableValue(1)
    const barUnitString = new DefaultObservableValue("001")
    const beatUnitString = new DefaultObservableValue("1")
    const semiquaverUnitString = new DefaultObservableValue("1")
    const ticksUnitString = new DefaultObservableValue("1")
    const unitDisplays = [
        <UnitDisplay lifecycle={lifecycle} name="bar" value={barUnitString} numChars={3}/>,
        <UnitDisplay lifecycle={lifecycle} name="beat" value={beatUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="semi" value={semiquaverUnitString} numChars={2}/>,
        <UnitDisplay lifecycle={lifecycle} name="ticks" value={ticksUnitString} numChars={3}/>
    ]
    return (
        <div className={className} onInit={element => {
            lifecycle.ownAll(
                service.engine.position.catchupAndSubscribe(owner => {
                    const position = owner.getValue()
                    const {bars, beats, semiquavers, ticks} = PPQN.toParts(Math.abs(position))
                    barUnitString.setValue((bars + 1).toString().padStart(3, "0"))
                    beatUnitString.setValue((beats + 1).toString())
                    semiquaverUnitString.setValue((semiquavers + 1).toString())
                    ticksUnitString.setValue(ticks.toString().padStart(3, "0"))
                    element.classList.toggle("negative", position < 0)
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