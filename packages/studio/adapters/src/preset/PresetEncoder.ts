import {Arrays, ByteArrayOutput} from "@opendaw/lib-std"
import {Box} from "@opendaw/lib-box"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {TransferUtils} from "../transfer"
import {PresetHeader} from "./PresetHeader"

export namespace PresetEncoder {
    export const encode = (audioUnitBox: AudioUnitBox): ArrayBufferLike => {
        const header = ByteArrayOutput.create()
        header.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
        header.writeInt(PresetHeader.FORMAT_VERSION)
        const preset = ProjectSkeleton.empty({createOutputCompressor: false, createDefaultUser: false})
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = preset
        const audioUnitBoxes = [audioUnitBox]
        const excludeBox = (box: Box): boolean =>
            TransferUtils.shouldExclude(box) || TransferUtils.excludeTimelinePredicate(box)
        boxGraph.beginTransaction()
        const dependencies = Array.from(audioUnitBox.graph.dependenciesOf(audioUnitBoxes, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes)
        const uuidMap = TransferUtils.generateMap(
            audioUnitBoxes, dependencies, rootBox.audioUnits.address.uuid, primaryAudioBusBox.address.uuid)
        TransferUtils.copyBoxes(uuidMap, boxGraph, audioUnitBoxes, dependencies)
        TransferUtils.reorderAudioUnits(uuidMap, audioUnitBoxes, rootBox)
        boxGraph.endTransaction()
        console.debug("SAVING...")
        boxGraph.debugBoxes()
        return Arrays.concatArrayBuffers(header.toArrayBuffer(), boxGraph.toArrayBuffer())
    }
}
