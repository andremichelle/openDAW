import css from "./TempoTrackBody.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "TempoTrackBody")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrackBody = ({}: Construct) => {
    return (
        <div className={className}>
            <canvas onInit={_canvas => {

            }}/>
        </div>
    )
}