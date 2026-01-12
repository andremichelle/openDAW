import {RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export namespace CodecsUtils {
    export const listSupportedCodecs = async (): Promise<void> => {
        const dialog = RuntimeNotifier.progress({headline: "Loading mediabunny..."})
        const {status, value: mediabunny, error} = await Promises.tryCatch(import("mediabunny"))
        dialog.terminate()
        if (status === "rejected") {
            await RuntimeNotifier.info({
                headline: "Error",
                message: `Could not load mediabunny: ${String(error)}`
            })
            return
        }
        const {getEncodableAudioCodecs, getEncodableVideoCodecs} = mediabunny
        const [audioCodecs, videoCodecs] = await Promise.all([
            getEncodableAudioCodecs(),
            getEncodableVideoCodecs()
        ])
        const audioList = audioCodecs.length > 0
            ? audioCodecs.join(", ")
            : "(none)"
        const videoList = videoCodecs.length > 0
            ? videoCodecs.join(", ")
            : "(none)"
        await RuntimeNotifier.info({
            headline: "Supported Codecs (Encoding)",
            message: `Audio:\n${audioList}\n\nVideo:\n${videoList}`
        })
    }
}