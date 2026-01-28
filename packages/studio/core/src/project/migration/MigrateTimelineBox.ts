import {BoxGraph} from "@moises-ai/lib-box"
import {UUID} from "@moises-ai/lib-std"
import {BoxIO, TimelineBox, ValueEventCollectionBox} from "@moises-ai/studio-boxes"

export const migrateTimelineBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, timelineBox: TimelineBox): void => {
    if (timelineBox.tempoTrack.events.isEmpty()) {
        console.debug("Migrate 'TimelineBox' to have a ValueEventCollectionBox for tempo events")
        boxGraph.beginTransaction()
        const box = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        timelineBox.tempoTrack.events.refer(box.owners)
        boxGraph.endTransaction()
    }
}