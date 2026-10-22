import {int, isDefined, Lazy, Nullable, Terminable, VitalSigns} from "@opendaw/lib-std"

// spins performance.now() into float64[0] while leased, burns one core
export class HRClockWorker {
    @Lazy
    static get(): HRClockWorker {return new HRClockWorker()}

    readonly sab: SharedArrayBuffer
    readonly #url: string

    #worker: Nullable<Worker> = null
    #leases: int = 0

    private constructor() {
        this.sab = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT)
        const code = `onmessage = (event) => {const now = new Float64Array(event.data); while (true) {now[0] = performance.now()}}`
        this.#url = URL.createObjectURL(new Blob([code], {type: "application/javascript"}))
    }

    lease(): Terminable {
        if (navigator.hardwareConcurrency < 4) {return Terminable.Empty}
        if (this.#leases++ === 0) {
            this.#worker = new Worker(this.#url)
            this.#worker.postMessage(this.sab)
        }
        const lease = new VitalSigns()
        return Terminable.create(() => {
            if (lease.isTerminated) {return}
            lease.terminate()
            if (--this.#leases === 0 && isDefined(this.#worker)) {
                this.#worker.terminate()
                this.#worker = null
                new Float64Array(this.sab)[0] = 0.0
            }
        })
    }
}