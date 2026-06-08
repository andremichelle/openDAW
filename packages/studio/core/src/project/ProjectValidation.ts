import {AudioRegionBox, BoxVisitor, NoteRegionBox, TrackBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Arrays, asDefined, EmptyExec, isDefined, RuntimeNotifier} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {Box} from "@opendaw/lib-box"

export namespace ProjectValidation {
    export const validate = (skeleton: ProjectSkeleton): void => {
        const {boxGraph} = skeleton
        const invalidBoxes = new Set<Box>()
        // A parameter field may have at most one automation (Value) track. Files saved before the
        // dedup guards can hold two -> the field adapter panics "Already assigned" during load-time
        // catchup, so the project cannot open. Collect Value tracks by target field to repair below.
        const automationTracksByTarget = new Map<string, Array<TrackBox>>()
        const validateRegion = (box: AudioRegionBox | ValueRegionBox | NoteRegionBox): void => {
            if (box.position.getValue() < 0) {
                console.warn(box, "must have a position greater equal 0")
                invalidBoxes.add(box)
            }
            if (box.duration.getValue() <= 0) {
                console.warn(box, "must have a duration greater than 0")
                invalidBoxes.add(box)
            }
        }
        boxGraph.boxes().forEach(box => box.accept<BoxVisitor>({
            visitNoteRegionBox: (box: NoteRegionBox) => validateRegion(box),
            visitValueRegionBox: (box: ValueRegionBox) => validateRegion(box),
            visitAudioRegionBox: (box: AudioRegionBox) => validateRegion(box),
            visitTrackBox: (box: TrackBox): void => {
                if (box.type.getValue() === TrackType.Value) {
                    box.target.targetAddress.ifSome(address => {
                        const key = address.toString()
                        const tracks = automationTracksByTarget.get(key)
                        if (isDefined(tracks)) {tracks.push(box)} else {automationTracksByTarget.set(key, [box])}
                    })
                }
                const regions = box.regions.pointerHub.incoming()
                    .map(({box}) => asDefined(box.accept<BoxVisitor<AudioRegionBox | ValueRegionBox | NoteRegionBox>>({
                        visitNoteRegionBox: (box: NoteRegionBox) => box,
                        visitValueRegionBox: (box: ValueRegionBox) => box,
                        visitAudioRegionBox: (box: AudioRegionBox) => box
                    }), "Box must be a NoteRegionBox, ValueRegionBox or AudioRegionBox"))
                    .sort((a, b) => a.position.getValue() - b.position.getValue())
                for (const [left, right] of Arrays.iterateAdjacent(regions)) {
                    if (right.position.getValue() < left.position.getValue() + left.duration.getValue()) {
                        console.warn(left, right, "Overlapping regions")
                        invalidBoxes.add(left)
                        invalidBoxes.add(right)
                    }
                }
            }
        }))
        automationTracksByTarget.forEach(tracks => {
            if (tracks.length <= 1) {return}
            // Keep the automation track holding the most regions (the real one); delete the duplicates.
            const keep = tracks.reduce((best, track) =>
                track.regions.pointerHub.incoming().length > best.regions.pointerHub.incoming().length ? track : best,
                tracks[0])
            tracks.forEach(track => {
                if (track !== keep) {
                    console.warn(track, "duplicate automation track for a parameter field")
                    invalidBoxes.add(track)
                }
            })
        })
        if (invalidBoxes.size === 0) {return}
        console.warn(`Deleting ${invalidBoxes.size} invalid boxes:`)
        boxGraph.beginTransaction()
        invalidBoxes.forEach(box => box.delete())
        boxGraph.endTransaction()
        RuntimeNotifier.info({
            headline: "Some data is corrupt",
            message: `The project contains ${invalidBoxes.size} invalid boxes. 
            We fixed them as good as possible. This probably happend because there was a bug that we hopefully fixed. 
            Please send this file to the developers.`
        }).then(EmptyExec, EmptyExec)
    }
}