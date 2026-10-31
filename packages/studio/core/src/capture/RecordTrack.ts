import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {asInstanceOf, Editing, int, isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"

export namespace RecordTrack {
    const TAKE_LABEL = /^Take (\d{1,9})$/

    export const findOrCreate = (editing: Editing,
                                 audioUnitBox: AudioUnitBox,
                                 type: TrackType,
                                 excludeTrack: Nullable<TrackBox> = null,
                                 alwaysNew: boolean = false): TrackBox => {
        let index: int = 0 | 0
        const trackBoxes = audioUnitBox.tracks.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, TrackBox))
            .sort((a, b) => a.index.getValue() - b.index.getValue())
        for (const trackBox of trackBoxes) {
            if (trackBox !== excludeTrack) {
                const hasNoRegions = trackBox.regions.pointerHub.isEmpty()
                const matchesType = trackBox.type.getValue() === type
                if (hasNoRegions && matchesType && !alwaysNew) {return trackBox}
            }
            index = Math.max(index, trackBox.index.getValue())
        }
        return editing.modify(() => createAt(audioUnitBox, type, index + 1)).unwrap("Could not create TrackBox")
    }

    export const nextIndex = (audioUnitBox: AudioUnitBox): int => audioUnitBox.tracks.pointerHub.incoming()
        .reduce((index, {box}) => Math.max(index, asInstanceOf(box, TrackBox).index.getValue() + 1), 0)

    const createAt = (audioUnitBox: AudioUnitBox, type: TrackType, index: int): TrackBox =>
        TrackBox.create(audioUnitBox.graph, UUID.generate(), box => {
            box.type.setValue(type)
            box.index.setValue(index)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
        })

    export const lastTakeNumber = (audioUnitBox: AudioUnitBox): int => {
        let highest: int = 0
        for (const {box: trackBox} of audioUnitBox.tracks.pointerHub.incoming()) {
            for (const {box} of asInstanceOf(trackBox, TrackBox).regions.pointerHub.incoming()) {
                const match = TAKE_LABEL.exec(UnionBoxTypes.asRegionBox(box).label.getValue())
                if (isDefined(match)) {highest = Math.max(highest, parseInt(match[1]))}
            }
        }
        return highest
    }
}