export interface LatencyCapture {
    startTime: number
    frames: Float32Array
}

/** Main-thread handle of LatencyCaptureProcessor: connect a source, call stop() to receive the frames. */
export class LatencyCaptureNode extends AudioWorkletNode {
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

    stop(): Promise<LatencyCapture> {
        this.port.postMessage("stop")
        return this.#result.promise
    }
}
