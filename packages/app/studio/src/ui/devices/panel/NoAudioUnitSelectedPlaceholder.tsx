import css from "./NoAudioUnitSelectedPlaceholder.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {CreateTrackButtons} from "@/ui/browse/CreateTrackButtons"

const className = Html.adoptStyleSheet(css, "NoAudioUnitSelectedPlaceholder")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const NoAudioUnitSelectedPlaceholder = ({lifecycle, service}: Construct) => (
    <div className={className}>
        <CreateTrackButtons lifecycle={lifecycle} service={service}/>
    </div>
)