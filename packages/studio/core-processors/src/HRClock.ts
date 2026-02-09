import {int} from "@opendaw/lib-std"

/**
 * High-resolution clock for AudioWorklet using a Worker-based timestamp provider.
 *
 * Problem: AudioWorklet has no access to performance.now() and cannot block.
 * Solution: A Worker provides timestamps via SharedArrayBuffer. The Worker writes
 * both the timestamp AND the counter-value it's responding to, allowing us to
 * verify that start/end timestamps are from the same render.
 *
 * Memory layout (32 bytes):
 *   int32[0]: request counter (incremented by HRClock on each signal)
 *   int32[1]: start response counter (odd signals)
 *   int32[2]: end response counter (even signals)
 *   float64[2]: start timestamp
 *   float64[3]: end timestamp
 *
 * Validation: We only use measurements where endCounter === startCounter + 1,
 * ensuring timestamps are from consecutive signals (same render). Invalid pairs
 * are dropped (return 0) rather than producing false spikes.
 */
export class HRClock {
    readonly #int32View: Int32Array
    readonly #float64View: Float64Array

    #prevStartCounter: int = 0
    #prevEndCounter: int = 0
    #prevStartTs: number = 0
    #prevEndTs: number = 0

    constructor(sab: SharedArrayBuffer) {
        this.#int32View = new Int32Array(sab)
        this.#float64View = new Float64Array(sab)
    }

    start(): number {
        // Read response counters to know which signals these timestamps are for
        const startCounter = Atomics.load(this.#int32View, 1)
        const endCounter = Atomics.load(this.#int32View, 2)
        // Read timestamps
        const startTs = this.#float64View[2]
        const endTs = this.#float64View[3]
        // Signal for T[N,start] - counter becomes odd
        this.#signal()
        // Only compute elapsed if we have a valid pair from the SAME render
        // A valid pair: endCounter = startCounter + 1 (end signal immediately follows start)
        let elapsed = 0
        if (this.#prevStartCounter > 0 && this.#prevEndCounter === this.#prevStartCounter + 1) {
            elapsed = this.#prevEndTs - this.#prevStartTs
        }
        // Store current values for the next render's calculation
        this.#prevStartCounter = startCounter
        this.#prevEndCounter = endCounter
        this.#prevStartTs = startTs
        this.#prevEndTs = endTs
        return elapsed
    }

    end(): void {
        // Signal for T[N,end] - counter becomes even
        this.#signal()
    }

    #signal(): void {
        Atomics.add(this.#int32View, 0, 1)
        Atomics.notify(this.#int32View, 0)
    }
}