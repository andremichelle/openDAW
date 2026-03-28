import {asInstanceOf, isDefined} from "@opendaw/lib-std"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, Validator} from "@opendaw/studio-adapters"
import {ProjectImpl} from "./impl"
import {Asserts} from "./Asserts"
import {AudioUnitBoxFactory} from "./AudioUnitBoxFactory"

export namespace ProjectConverter {
    export const toSkeleton = (project: ProjectImpl): ProjectSkeleton => {
        Asserts.assertNoNaN(project)
        console.time("convert")
        const skeleton = ProjectSkeleton.empty({
            createDefaultUser: true,
            createOutputMaximizer: false
        })
        const {boxGraph, mandatoryBoxes: {rootBox, timelineBox, userInterfaceBoxes: [defaultUser]}} = skeleton
        const {bpm, timeSignature} = project

        boxGraph.beginTransaction()
        timelineBox.bpm.setValue(Validator.clampBpm(bpm))
        const [numerator, denominator] = Validator.isTimeSignatureValid(
            timeSignature.numerator, timeSignature.denominator).result()
        timelineBox.signature.nominator.setValue(numerator)
        timelineBox.signature.denominator.setValue(denominator)
        AudioUnitBoxFactory.create(skeleton, project)
        // select the first audio unit as the editing device
        const firstAudioUnitBox = rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .sort(({index: a}, {index: b}) => a.getValue() - b.getValue())
            .at(0)
        if (isDefined(firstAudioUnitBox)) {
            defaultUser.editingDeviceChain.refer(firstAudioUnitBox.editing)
        }
        boxGraph.endTransaction()
        console.timeEnd("convert")
        boxGraph.verifyPointers()
        if (Validator.hasOverlappingRegions(boxGraph)) {
            throw new Error("Project contains overlapping regions")
        }
        return skeleton
    }
}