import {AudioRegionBox, BoxVisitor, NoteRegionBox, TrackBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {Arrays, asDefined, EmptyExec, RuntimeNotifier} from "@opendaw/lib-std"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Box} from "@opendaw/lib-box"

export namespace ProjectValidation {
    export const validate = (skeleton: ProjectSkeleton): void => {
        const {boxGraph} = skeleton
        const invalidBoxes: Array<Box> = []
        const validateRegion = (box: AudioRegionBox | ValueRegionBox | NoteRegionBox): void => {
            if (box.position.getValue() < 0) {
                console.warn(box, "must have a position greater equal 0")
                invalidBoxes.push(box)
            }
            if (box.duration.getValue() <= 0) {
                console.warn(box, "must have a duration greater than 0")
                invalidBoxes.push(box)
            }
        }
        boxGraph.boxes().forEach(box => box.accept<BoxVisitor>({
            visitNoteRegionBox: (box: NoteRegionBox) => validateRegion(box),
            visitValueRegionBox: (box: ValueRegionBox) => validateRegion(box),
            visitAudioRegionBox: (box: AudioRegionBox) => validateRegion(box),
            visitTrackBox: (box: TrackBox): void => Arrays.iterateAdjacent(box.regions.pointerHub.incoming()
                .map(({box}) => asDefined(box.accept<BoxVisitor<AudioRegionBox | ValueRegionBox | NoteRegionBox>>({
                    visitNoteRegionBox: (box: NoteRegionBox) => box,
                    visitValueRegionBox: (box: ValueRegionBox) => box,
                    visitAudioRegionBox: (box: AudioRegionBox) => box
                }), "Box must be a NoteRegionBox, ValueRegionBox or AudioRegionBox"))
                .sort((a, b) => a.position.getValue() - b.position.getValue()))
                .forEach(([left, right]) => {
                    if (right.position.getValue() < left.position.getValue() + left.duration.getValue()) {
                        console.warn(left, right, "Overlapping regions")
                        invalidBoxes.push(left, right)
                    }
                })
        }))
        if (invalidBoxes.length === 0) {return}
        console.warn(`Deleting ${invalidBoxes.length} invalid boxes:`)
        boxGraph.beginTransaction()
        invalidBoxes.forEach(box => box.delete())
        boxGraph.endTransaction()
        RuntimeNotifier.info({
            headline: "Some data is corrupt",
            message: `The project contains ${invalidBoxes.length} invalid boxes. 
            We fixed them as good as possible. This probably happend because there was a bug that we hopefully fixed. 
            Please send this file to the developers.`
        }).then(EmptyExec, EmptyExec)
    }
}