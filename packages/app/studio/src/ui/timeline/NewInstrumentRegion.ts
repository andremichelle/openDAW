import {asInstanceOf, isAbsent} from "@opendaw/lib-std"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {TrackType} from "@opendaw/studio-adapters"
import {Project, StudioPreferences} from "@opendaw/studio-core"
import {Snapping} from "@/ui/timeline/Snapping"

export namespace NewInstrumentRegion {
    export const create = (project: Project, snapping: Snapping, audioUnitBox: AudioUnitBox): void => {
        if (!StudioPreferences.settings.editing["new-instrument-note-region"]) {return}
        const {engine, api, selection, regionSelection, userEditingManager, timelineBoxAdapter} = project
        if (engine.isPlaying.getValue()) {return}
        const tracks = audioUnitBox.tracks.pointerHub.incoming().map(({box}) => asInstanceOf(box, TrackBox))
        if (tracks.some(track => track.regions.pointerHub.incoming().length > 0
            || track.clips.pointerHub.incoming().length > 0)) {return}
        const noteTrack = tracks.find(track => track.type.getValue() === TrackType.Notes)
        if (isAbsent(noteTrack)) {return}
        const position = Math.max(0, snapping.floor(engine.position.getValue()))
        api.createTrackRegion(noteTrack, position, timelineBoxAdapter.signatureTrack.barLengthAt(position))
            .ifSome(regionBox => {
                regionSelection.deselectAll()
                selection.select(regionBox)
                userEditingManager.timeline.edit(regionBox)
            })
    }
}
