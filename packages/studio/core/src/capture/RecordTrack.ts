import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {asInstanceOf, Editing, int, isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {TrackType, UnionBoxTypes} from "@opendaw/studio-adapters"

export namespace RecordTrack {
    const TAKE_LABEL = /^Take (\d+)$/

    export const findOrCreate = (editing: Editing,
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

    export const takeLabel = (takeNumber: int): string => `Take ${takeNumber}`

    export const nextTakeNumber = (audioUnitBox: AudioUnitBox, lastInRecording: int): int => {
        let highest: int = lastInRecording
        for (const {box: trackBox} of audioUnitBox.tracks.pointerHub.incoming()) {
            for (const {box} of asInstanceOf(trackBox, TrackBox).regions.pointerHub.incoming()) {
                const match = TAKE_LABEL.exec(UnionBoxTypes.asRegionBox(box).label.getValue())
                if (!isDefined(match)) {continue}
                const takeNumber = parseInt(match[1])
                if (Number.isSafeInteger(takeNumber)) {highest = Math.max(highest, takeNumber)}
            }
        }
        return highest + 1
    }
}