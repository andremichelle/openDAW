import {Bytes, DefaultObservableValue, Errors, Nullable, RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ensureInference} from "@/service/InferenceLoader"

export namespace TempoDetection {
    /**
     * Run tempo detection on a single audio buffer with download and progress
     * dialogs. Returns the detected BPM, or `null` if the user canceled or
     * the run failed (callers should treat null as "abort the surrounding
     * operation"). The progress dialog headline includes `sampleName` so
     * users can tell which sample is being analyzed when the surrounding
     * flow processes several stems back-to-back.
     */
    export const runOne = async (audio: Float32Array,
                                 sampleRate: number,
                                 sampleName: string): Promise<Nullable<number>> => {
        const Inference = await ensureInference()
        const cached = await Inference.isCached("tempo-detection")
        if (!cached) {
            const downloadProgress = new DefaultObservableValue<number>(0)
            const downloadController = new AbortController()
            const sizeLabel = Bytes.toString(Inference.modelDescriptor("tempo-detection").bytes)
            const dialog = RuntimeNotifier.progress({
                headline: "Downloading tempo model",
                message: `${sizeLabel}, one-time`,
                progress: downloadProgress,
                cancel: () => downloadController.abort(Errors.AbortError)
            })
            const preloadResult = await Promises.tryCatch(Inference.preload("tempo-detection", {
                progress: value => downloadProgress.setValue(value),
                signal: downloadController.signal
            }))
            dialog.terminate()
            if (preloadResult.status === "rejected") {
                if (Errors.isAbort(preloadResult.error)) {return null}
                console.warn(preloadResult.error)
                RuntimeNotifier.notify({message: "Could not load tempo model.", icon: "Warning"})
                return null
            }
        }
        const detectProgress = new DefaultObservableValue<number>(0)
        const detectController = new AbortController()
        const dialog = RuntimeNotifier.progress({
            headline: `Detecting tempo: ${sampleName}`,
            progress: detectProgress,
            cancel: () => detectController.abort(Errors.AbortError)
        })
        const result = await Promises.tryCatch(Inference.run("tempo-detection",
            {audio, sampleRate}, {
                progress: value => detectProgress.setValue(value),
                signal: detectController.signal,
                downloadShare: 0
            }))
        dialog.terminate()
        if (result.status === "rejected") {
            if (Errors.isAbort(result.error)) {return null}
            console.warn(result.error)
            RuntimeNotifier.notify({message: "Tempo detection failed.", icon: "Warning"})
            return null
        }
        return result.value.bpm
    }
}