import {int, TimeSpan} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"

export interface LatencyCapture {
    startTime: number
    frames: Float32Array
}

/** Main-thread handle of LatencyCaptureProcessor: connect a source, call stop() to receive the frames. */
export class LatencyCaptureNode extends AudioWorkletNode {
    /** The frames follow the stop message at once; a processor that is gone never sends them. */
    static readonly StopDeadlineMs: int = 2000

    static create(context: BaseAudioContext): LatencyCaptureNode {
        return new LatencyCaptureNode(context)
    }

    readonly #result = Promise.withResolvers<LatencyCapture>()

    private constructor(context: BaseAudioContext) {
        super(context, "latency-capture-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
            channelCountMode: "explicit"
        })

        this.port.addEventListener("message", ({data}: MessageEvent) => {
            if (data?.type === "frames") {
                this.#result.resolve({startTime: data.startTime, frames: data.frames})
            }
        })
        this.port.start()
    }

    stop(deadlineMs: int = LatencyCaptureNode.StopDeadlineMs): Promise<LatencyCapture> {
        this.port.postMessage("stop")
        return Promises.timeout(this.#result.promise, TimeSpan.millis(deadlineMs),
            `latency capture delivered no frames within ${deadlineMs} ms`)
    }
}
