// Singleton - one clock worker shared across engine instances
import {Lazy} from "@opendaw/lib-std"

let instance: HRClockWorker | undefined

export class HRClockWorker {
    @Lazy
    static get(): HRClockWorker {return new HRClockWorker()}

    readonly sab: SharedArrayBuffer
    readonly #worker: Worker

    private constructor() {
        // Layout (32 bytes):
        // int32[0]: request counter
        // int32[1]: start response counter (which request this start timestamp is for)
        // int32[2]: end response counter (which request this end timestamp is for)
        // float64[2]: start timestamp (bytes 16-23)
        // float64[3]: end timestamp (bytes 24-31)
        this.sab = new SharedArrayBuffer(32)
        const code = `
            onmessage = (e) => {
                const int32 = new Int32Array(e.data)
                const float64 = new Float64Array(e.data)
                let lastCounter = 0
                while (true) {
                    Atomics.wait(int32, 0, lastCounter)
                    lastCounter = Atomics.load(int32, 0)
                    const isStart = (lastCounter & 1) === 1
                    if (isStart) {
                        float64[2] = performance.now()
                        Atomics.store(int32, 1, lastCounter)
                    } else {
                        float64[3] = performance.now()
                        Atomics.store(int32, 2, lastCounter)
                    }
                }
            }
        `
        const blob = new Blob([code], {type: "application/javascript"})
        this.#worker = new Worker(URL.createObjectURL(blob))
        this.#worker.postMessage(this.sab)
    }
}