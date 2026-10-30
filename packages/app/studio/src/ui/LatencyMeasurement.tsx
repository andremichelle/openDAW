import {EmptyExec} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Promises} from "@opendaw/lib-runtime"
import {CaptureAudio, RoundTrip} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs"

export namespace LatencyMeasurement {
    const format = (seconds: number): string => `${(seconds * 1000.0).toFixed(1)} ms`

    const outcome = (result: RoundTrip.Result): string => {
        switch (result.verdict) {
            case "ok":
                return `The round trip is ${format(result.seconds)}. Recordings with this input and output use it from now on.`
            case "unsteady":
                return `The bursts arrived ${format(result.spreadSeconds)} apart, too far to trust. Nothing was changed. Try again with the output louder or the microphone closer.`
            case "no-signal":
                return "The input did not hear the bursts. Nothing was changed. Turn the output up, or hold your headphones to the microphone."
        }
    }

    export const start = async (capture: CaptureAudio): Promise<void> => {
        const {status} = await Promises.tryCatch(Dialogs.show({
            headline: "Measure Latency",
            content: (
                <div>
                    <p>openDAW plays three short noise bursts and listens for them on this input, so recordings land exactly in time.</p>
                    <p>The input has to hear the output: speakers work as they are, hold headphones to the microphone.</p>
                    <p><a href="/manuals/latency-calibration" target="manuals">How it works</a></p>
                </div>
            ),
            okText: "Measure",
            buttons: [{text: "Cancel", primary: false, onClick: handler => handler.close()}]
        }))
        if (status === "rejected") {return}
        const listening = new AbortController()
        Dialogs.show({
            headline: "Measuring Latency",
            content: <p>Listening...</p>,
            excludeOk: true,
            cancelable: false,
            abortSignal: listening.signal
        }).catch(EmptyExec)
        const measured = await Promises.tryCatch(capture.measureRoundTrip())
        listening.abort()
        await Dialogs.info({
            headline: "Measure Latency",
            message: measured.status === "resolved" ? outcome(measured.value) : `Could not measure: ${String(measured.error)}`
        })
    }
}
