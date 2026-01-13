import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {AudioContentFactory, RegionClipResolver} from "@moises-ai/studio-core"
import {CreateParameters, TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {Snapping} from "@/ui/timeline/Snapping"
import {StudioService} from "@/service/StudioService"
import {TransientPlayMode} from "@moises-ai/studio-enums"
import {AudioRegionBoxAdapter} from "@moises-ai/studio-adapters"

export class RegionDragAndDrop extends TimelineDragAndDrop<RegionCaptureTarget> {
    readonly #snapping: Snapping

    constructor(service: StudioService, capturing: ElementCapturing<RegionCaptureTarget>, snapping: Snapping) {
        super(service, capturing)

        this.#snapping = snapping
    }

    handleSample({event, trackBoxAdapter, audioFileBox, sample}: CreateParameters): void {
        const pointerX = event.clientX - this.capturing.element.getBoundingClientRect().left
        const pointerPulse = Math.max(this.#snapping.xToUnitFloor(pointerX), 0)
        const boxGraph = this.project.boxGraph
        const regionBox = sample.bpm === 0
            ? AudioContentFactory.createNotStretchedRegion({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position: pointerPulse
            })
            :
            AudioContentFactory.createTimeStretchedRegion({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                audioFileBox,
                sample,
                position: pointerPulse,
                playbackRate: 1.0,
                transientPlayMode: TransientPlayMode.Pingpong
            })
        const regionAdapter = this.project.boxAdapters.adapterFor(regionBox, AudioRegionBoxAdapter)
        RegionClipResolver.fromRange(trackBoxAdapter, pointerPulse, pointerPulse + regionAdapter.duration)()
    }
}