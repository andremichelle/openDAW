import {WavFile} from "@moises-ai/lib-dsp"
import {Promises} from "@moises-ai/lib-runtime"
import {Files} from "@moises-ai/lib-dom"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter} from "@moises-ai/studio-adapters"

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
