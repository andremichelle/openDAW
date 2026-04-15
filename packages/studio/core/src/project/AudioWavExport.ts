import {WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"

export namespace AudioWavExport {
    export const toFile = async (owner: AudioRegionBoxAdapter | AudioClipBoxAdapter,
                                 suggestedName: string = "audio.wav") => {
        const data = owner.file.data.unwrap("Audio data is not loaded")
        return Promises.tryCatch(Files.save(WavFile.encodeFloats(data) as ArrayBuffer, {
            types: [{
                description: "Wav File",
                accept: {"audio/wav": [".wav"]}
            }], suggestedName
        }))
    }
}
