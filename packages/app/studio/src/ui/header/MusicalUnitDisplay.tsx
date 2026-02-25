import css from "./MusicalUnitDisplay.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {DefaultObservableValue, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {StudioService} from "@/service/StudioService"
import {StudioPreferences} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "MusicalUnitDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const MusicalUnitDisplay = ({lifecycle, service}: Construct) => {
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
                    const {bars, beats, semiquavers, ticks} = service.projectProfileService.getValue().match({
                        some: ({project}) => project.timelineBoxAdapter.signatureTrack.toParts(position),
                        none: () => ({bars: 0, beats: 0, semiquavers: 0, ticks: 0})
                    })
                    barUnitString.setValue((bars + 1).toString().padStart(3, "0"))
                    beatUnitString.setValue((beats + 1).toString())
                    semiquaverUnitString.setValue((semiquavers + 1).toString())
                    ticksUnitString.setValue(ticks.toString().padStart(3, "0"))
                    element.classList.toggle("negative", position < 0)
                }),
                StudioPreferences.catchupAndSubscribe(enabled =>
                    element.classList.toggle("hidden", !enabled), "time-display", "musical"),
                StudioPreferences.catchupAndSubscribe(details => {
                    const maxIndex = details ? 3 : 1
                    unitDisplays.forEach((element, index) => element.classList.toggle("hidden", index > maxIndex))
                }, "time-display", "details")
            )
        }}>{unitDisplays}</div>
    )
}