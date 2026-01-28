import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {asInstanceOf, int, Nullable, UUID} from "@opendaw/lib-std"
import {TrackType} from "@opendaw/studio-adapters"
import {BoxEditing} from "@opendaw/lib-box"

export namespace RecordTrack {
    export const findOrCreate = (editing: BoxEditing,
                                 audioUnitBox: AudioUnitBox,
                                 type: TrackType,
                                 excludeTrack: Nullable<TrackBox> = null): TrackBox => {
        let index: int = 0 | 0
        const trackBoxes = audioUnitBox.tracks.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, TrackBox))
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        for (const trackBox of trackBoxes) {
            if (trackBox !== excludeTrack) {
                const hasNoRegions = trackBox.regions.pointerHub.isEmpty()
                const matchesType = trackBox.type.getValue() === type
                if (hasNoRegions && matchesType) {return trackBox}
            }
            index = Math.max(index, trackBox.index.getValue())
        }
        return editing.modify(() => TrackBox.create(audioUnitBox.graph, UUID.generate(), box => {
            box.type.setValue(type)
            box.index.setValue(index + 1)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
        })).unwrap("Could not create TrackBox")
    }
}