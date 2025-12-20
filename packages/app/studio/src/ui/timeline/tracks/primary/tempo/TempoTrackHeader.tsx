import css from "./TempoTrackHeader.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "TempoTrackHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrackHeader = ({}: Construct) => {
    return (<div className={className}>Tempo</div>)
}