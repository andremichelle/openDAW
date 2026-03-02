import {CreateParameters, TimelineDragAndDrop} from "@/ui/timeline/tracks/audio-unit/TimelineDragAndDrop"
import {ClipCaptureTarget} from "./ClipCapturing"
import {ClipWidth} from "@/ui/timeline/tracks/audio-unit/clips/constants"
import {StudioService} from "@/service/StudioService"
import {AudioContentFactory, ElementCapturing} from "@opendaw/studio-core"

export class ClipDragAndDrop extends TimelineDragAndDrop<ClipCaptureTarget> {
    constructor(service: StudioService, capturing: ElementCapturing<ClipCaptureTarget>) {
        super(service, capturing)
    }

    handleSample({event, trackBoxAdapter, audioFileBox, sample, type}: CreateParameters): void {
        const x = event.clientX - this.capturing.element.getBoundingClientRect().left
        const index = Math.floor(x / ClipWidth)
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
    }
}