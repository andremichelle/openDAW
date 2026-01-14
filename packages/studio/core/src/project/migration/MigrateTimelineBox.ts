import {BoxGraph} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {BoxIO, TimelineBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"

export const migrateTimelineBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, timelineBox: TimelineBox): void => {
    if (timelineBox.tempoTrack.events.isEmpty()) {
        console.debug("Migrate 'TimelineBox' to have a ValueEventCollectionBox for tempo events")
        boxGraph.beginTransaction()
        const box = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        timelineBox.tempoTrack.events.refer(box.owners)
        boxGraph.endTransaction()
    }
}