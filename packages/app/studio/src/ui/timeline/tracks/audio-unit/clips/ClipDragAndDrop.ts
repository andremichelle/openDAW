import {CreateParameters, TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {ClipCaptureTarget} from "./ClipCapturing"
import {ClipWidth} from "@/ui/timeline/tracks/audio-unit/clips/constants"
import {StudioService} from "@/service/StudioService"
import {AudioContentFactory, ElementCapturing} from "@opendaw/studio-core"
import {ClipsView} from "@/ui/timeline/ClipsView"
import {AnyDragData} from "@/ui/AnyDragData"

export class ClipDragAndDrop extends TimelineDragAndDrop<ClipCaptureTarget> {
    readonly #clips: ClipsView

    constructor(service: StudioService, capturing: ElementCapturing<ClipCaptureTarget>) {
        super(service, capturing)
        this.#clips = service.timeline.clips
    }

    drop(event: DragEvent, data: AnyDragData): Promise<void> {
        const index = this.#captureIndex(event)
        return super.drop(event, data, parameters => this.handleSample(parameters, index))
    }

    handleSample({event, trackBoxAdapter, audioFileBox, sample, type}: CreateParameters,
                 index = this.#captureIndex(event)): void {
        trackBoxAdapter.clips.collection.getAdapterByIndex(index)
            .ifSome(adapter => adapter.box.delete())
        const {boxGraph} = this.project
        if (type === "file" || sample.bpm === 0) {
            AudioContentFactory.createNotStretchedClip({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                sample,
                audioFileBox,
                index
            })
        } else {
            AudioContentFactory.createTimeStretchedClip({
                boxGraph,
                targetTrack: trackBoxAdapter.box,
                sample,
                audioFileBox,
                index
            })
        }
        this.#clips.ensureColumn(index)
    }

    #captureIndex(event: DragEvent): number {
        const x = event.clientX - this.capturing.element.getBoundingClientRect().left
        return Math.floor(x / ClipWidth) + this.#clips.scroll.getValue()
    }
}
