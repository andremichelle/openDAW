import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {AudioContentFactory, ElementCapturing} from "@opendaw/studio-core"
import {CreateParameters, TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {Snapping} from "@/ui/timeline/Snapping"
import {StudioService} from "@/service/StudioService"
import {TransientPlayMode} from "@opendaw/studio-enums"

export class RegionDragAndDrop extends TimelineDragAndDrop<RegionCaptureTarget> {
    readonly #snapping: Snapping

    constructor(service: StudioService, capturing: ElementCapturing<RegionCaptureTarget>, snapping: Snapping) {
        super(service, capturing)

        this.#snapping = snapping
    }

    handleSample({event, trackBoxAdapter, audioFileBox, sample, type}: CreateParameters): void {
        const pointerX = event.clientX - this.capturing.element.getBoundingClientRect().left
        const pointerPulse = Math.max(this.#snapping.xToUnitFloor(pointerX), 0)
        const boxGraph = this.project.boxGraph
        // Calculate duration to determine target track and handle overlaps
        const duration = AudioContentFactory.calculateDuration(sample)
        const complete = pointerPulse + duration
        // Resolve target track (handles keep-existing by finding non-overlapping track)
        const targetTrack = this.project.overlapResolver.resolveTargetTrack(trackBoxAdapter, pointerPulse, complete)
        // Capture overlap state before creating (handles clip/push-existing)
        const solver = this.project.overlapResolver.fromRange(targetTrack, pointerPulse, complete)
        // Create region on target track
        type === "file" || sample.bpm === 0
            ? AudioContentFactory.createNotStretchedRegion({
                boxGraph,
                targetTrack: targetTrack.box,
                audioFileBox,
                sample,
                position: pointerPulse
            })
            : AudioContentFactory.createTimeStretchedRegion({
                boxGraph,
                targetTrack: targetTrack.box,
                audioFileBox,
                sample,
                position: pointerPulse,
                playbackRate: 1.0,
                transientPlayMode: TransientPlayMode.Pingpong
            })
        // Apply overlap resolution
        solver()
    }
}