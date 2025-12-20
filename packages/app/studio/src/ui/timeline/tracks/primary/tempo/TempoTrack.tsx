import css from "./TempoTrack.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {TempoTrackBody} from "@/ui/timeline/tracks/primary/tempo/TempoTrackBody.tsx"
import {TempoTrackHeader} from "@/ui/timeline/tracks/primary/tempo/TempoTrackHeader.tsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "TempoTrack")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrack = ({lifecycle, service}: Construct) => {
    const classList = Inject.classList(className)
    return (
        <div className={classList}>
            <TempoTrackHeader lifecycle={lifecycle} service={service}/>
            <div className="void"/>
            <TempoTrackBody lifecycle={lifecycle} service={service}/>
        </div>
    )
}