import css from "./TempoTrackBody.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {CanvasPainter} from "@/ui/canvas/painter"

const className = Html.adoptStyleSheet(css, "TempoTrackBody")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const TempoTrackBody = ({lifecycle, service}: Construct) => {
    const {project} = service
    return (
        <div className={className}>
            <canvas onInit={canvas => {
                const painter = new CanvasPainter(canvas, painter => {
                    painter.context
                })
                lifecycle.ownAll(project.timelineBoxAdapter.tempoTrack.catchupAndSubscribe(painter.requestUpdate))
            }}/>
        </div>
    )
}