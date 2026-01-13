import {Arrays, ByteArrayOutput} from "@moises-ai/lib-std"
import {AudioUnitBox} from "@moises-ai/studio-boxes"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {ProjectUtils} from "../project/ProjectUtils"
import {PresetHeader} from "./PresetHeader"

export namespace PresetEncoder {
    export const encode = (audioUnitBox: AudioUnitBox): ArrayBufferLike => {
        const header = ByteArrayOutput.create()
        header.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
        header.writeInt(PresetHeader.FORMAT_VERSION)
        const preset = ProjectSkeleton.empty({createOutputCompressor: false, createDefaultUser: false})
        preset.boxGraph.beginTransaction()
        ProjectUtils.extractAudioUnits([audioUnitBox], preset, {excludeTimeline: true})
        preset.boxGraph.endTransaction()
        console.debug("SAVING...")
        preset.boxGraph.debugBoxes()
        return Arrays.concatArrayBuffers(header.toArrayBuffer(), preset.boxGraph.toArrayBuffer())
    }
}