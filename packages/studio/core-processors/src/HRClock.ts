// reads the timestamp the HRClockWorker spins into the buffer, 0 when the worker is not running or stalled
export class HRClock {
    readonly #now: Float64Array

    #start: number = 0.0

    constructor(sab: SharedArrayBuffer) {this.#now = new Float64Array(sab, 0, 1)}

    start(): void {this.#start = this.#now[0]}

    end(): number {return this.#start === 0.0 ? 0.0 : this.#now[0] - this.#start}
}