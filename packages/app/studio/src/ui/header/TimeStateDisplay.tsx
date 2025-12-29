import css from "./TimeStateDisplay.sass?inline"
import {float, Lifecycle, ObservableValue, Option, Terminator} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {ProjectProfile} from "@opendaw/studio-core"
import {TapButton} from "@/ui/header/TapButton"
import {MusicalUnitDisplay} from "@/ui/header/MusicalUnitDisplay"
import {AbsoluteUnitDisplay} from "@/ui/header/AbsoluteUnitDisplay"
import {TempoControl} from "@/ui/header/TempoControl"
import {MeterControl} from "@/ui/header/MeterControl"

const className = Html.adoptStyleSheet(css, "TimeStateDisplay")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TimeStateDisplay = ({lifecycle, service}: Construct) => {
    const {projectProfileService} = service
    const shuffleDigit = Inject.value("60")

    const projectActiveLifeTime = lifecycle.own(new Terminator())
    const projectProfileObserver = (optProfile: Option<ProjectProfile>) => {
        projectActiveLifeTime.terminate()
        if (optProfile.isEmpty()) {return}
        const {project} = optProfile.unwrap()
        const {rootBoxAdapter} = project
        projectActiveLifeTime.ownAll(
            rootBoxAdapter.groove.box.amount.catchupAndSubscribe((owner: ObservableValue<float>) =>
                shuffleDigit.value = String(Math.round(owner.getValue() * 100)))
        )
    }
    lifecycle.own(projectProfileService.catchupAndSubscribe(projectProfileObserver))
    const element: HTMLElement = (
        <div className={className}>
            <MusicalUnitDisplay lifecycle={lifecycle} service={service}/>
            <AbsoluteUnitDisplay lifecycle={lifecycle} service={service}/>
            <TempoControl lifecycle={lifecycle} service={service}/>
            <TapButton service={service}/>
            <MeterControl lifecycle={lifecycle} service={service}/>
        </div>
    )
    return element
}