import {Provider, RuntimeNotifier} from "@opendaw/lib-std"
import {RecordingLatency} from "../RecordingLatency"

export namespace BrowserRecordingLatency {
    // a browser without `outputLatency` records off by an unknown amount: the user decides
    export const approveMissing = async (context: AudioContext): Promise<boolean> => {
        if (context.outputLatency !== undefined) {return true}
        return RuntimeNotifier.approve({
            headline: "Warning",
            message: "Your browser does not support 'output latency'. This will cause timing issue while recording.",
            approveText: "Ignore",
            cancelText: "Cancel"
        })
    }

    // `outputLatency` reads zero until the output runs: a later zero keeps the last real read
    export const reader = (context: AudioContext, resolveInput: (outputLatency: number) => number)
        : Provider<RecordingLatency> => {
        let lastOutputLatency = 0.0
        return () => {
            const read = context.outputLatency ?? 0.0
            if (Number.isFinite(read) && read > 0.0) {lastOutputLatency = read}
            const outputLatency = lastOutputLatency
            return {outputLatency, inputLatency: resolveInput(outputLatency)}
        }
    }
}
