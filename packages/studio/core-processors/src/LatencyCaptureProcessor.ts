/** Records channel 0 of its input from the first quantum with input until told to stop, then hands the frames back. */
export class LatencyCaptureProcessor extends AudioWorkletProcessor {
    readonly #chunks: Array<Float32Array> = []

    #startTime: number = Number.NaN
    #running: boolean = true

    constructor() {
        super()

        this.port.onmessage = ({data}: MessageEvent) => {
            if (data === "stop") {
                this.#running = false
                const total = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0)
                const frames = new Float32Array(total)
                let offset = 0
                for (const chunk of this.#chunks) {
                    frames.set(chunk, offset)
                    offset += chunk.length
                }
                this.port.postMessage({type: "frames", startTime: this.#startTime, frames}, [frames.buffer])
            }
        }
    }

    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
        if (!this.#running) {return false}
        const channel = inputs[0]?.[0]
        if (channel === undefined) {return true}
        if (Number.isNaN(this.#startTime)) {
            // Report the audio-thread time of the first captured frame, once, the moment input
            // actually arrives — the port message reporting "stop" carries only the frame count,
            // not when they started, and the main thread needs both to place the capture on its clock.
            this.#startTime = currentTime
        }
        this.#chunks.push(channel.slice())
        return true
    }
}
