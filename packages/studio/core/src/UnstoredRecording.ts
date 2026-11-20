import {RuntimeNotifier} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"

export namespace UnstoredRecording {
    export const offerDownload = async (audio: AudioData, name: string, error: unknown): Promise<boolean> => {
        const reason = error instanceof Error ? error.message : String(error)
        while (await RuntimeNotifier.approve({
            headline: "Recording Not Saved",
            message: `'${name}' could not be saved in the browser (${reason}). Download it as a WAV file so it is not lost. You can import the file again later.`,
            approveText: "Download WAV",
            cancelText: "Discard"
        })) {
            const saved = await Promises.tryCatch(Files.save(WavFile.encodeFloats(audio) as ArrayBuffer, {
                suggestedName: `${name}.wav`,
                types: [{description: "Wav File", accept: {"audio/wav": [".wav"]}}]
            }))
            if (saved.status === "resolved") {return true}
        }
        return false
    }
}
