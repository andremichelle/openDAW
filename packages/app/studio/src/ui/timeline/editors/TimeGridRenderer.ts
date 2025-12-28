import {Snapping} from "@/ui/timeline/Snapping.ts"
import {TimeGrid, TimelineRange} from "@opendaw/studio-core"
import {SignatureTrackAdapter} from "@opendaw/studio-adapters"

const SnapColor = "rgba(0, 0, 0, 0.20)"
const SubSnapColor = "rgba(0, 0, 0, 0.06)"

export const renderTimeGrid = (context: CanvasRenderingContext2D,
                               signatureTrack: SignatureTrackAdapter,
                               range: TimelineRange,
                               snapping: Snapping,
                               top: number,
                               bottom: number) => {
    TimeGrid.fragment(signatureTrack, range, ({pulse, ticks}) => {
        const x = Math.floor(range.unitToX(pulse) * devicePixelRatio)
        context.fillStyle = ticks % snapping.value(pulse) === 0 ? SnapColor : SubSnapColor
        context.fillRect(x, top, devicePixelRatio, bottom - top)
    }, {minLength: 16})
}