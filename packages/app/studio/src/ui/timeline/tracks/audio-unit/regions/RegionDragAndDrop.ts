import {PPQN} from "@opendaw/lib-dsp"
import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {AudioContentFactory, RegionClipResolver} from "@opendaw/studio-core"
import {CreateParameters, TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {Snapping} from "@/ui/timeline/Snapping"
import {StudioService} from "@/service/StudioService"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {quantizeRound} from "@opendaw/lib-std"

export class RegionDragAndDrop extends TimelineDragAndDrop<RegionCaptureTarget> {
    readonly #snapping: Snapping

    constructor(service: StudioService, capturing: ElementCapturing<RegionCaptureTarget>, snapping: Snapping) {
        super(service, capturing)

        this.#snapping = snapping
    }

    handleSample({event, trackBoxAdapter, audioFileBox, sample}: CreateParameters): void {
        const pointerX = event.clientX - this.capturing.element.getBoundingClientRect().left
        const pointerPulse = Math.max(this.#snapping.xToUnitFloor(pointerX), 0)
        const {duration: durationInSeconds, bpm} = sample
        const duration = quantizeRound(PPQN.secondsToPulses(durationInSeconds, bpm), PPQN.SemiQuaver)
        const solver = RegionClipResolver.fromRange(trackBoxAdapter, pointerPulse, pointerPulse + duration)
        const boxGraph = this.project.boxGraph
        if (sample.bpm === 0) {
            AudioContentFactory.createNotStretchedRegion({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position: pointerPulse
            })
        } else {
            AudioContentFactory.createTimeStretchedRegion({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position: pointerPulse,
                playbackRate: 1.0,
                transientPlayMode: TransientPlayMode.Pingpong
            })
        }
        solver()
    }
}