import {clamp, int, unitValue} from "@opendaw/lib-std"

export namespace DuckerScale {
    export const DbMin = -60.0
    export const DbMax = 6.0

    export const dbToUnit = (db: number): unitValue => clamp((db - DbMin) / (DbMax - DbMin), 0.0, 1.0)
    export const gainToUnit = (gain: number): unitValue =>
        gain <= 0.0 ? 0.0 : dbToUnit(20.0 * Math.log10(gain))
    export const unitToDb = (unit: unitValue): number => DbMin + clamp(unit, 0.0, 1.0) * (DbMax - DbMin)
    export const reductionToUnit = (gain: number): unitValue =>
        gain <= 0.0 ? 0.0 : clamp(1.0 + 20.0 * Math.log10(gain) / (DbMax - DbMin), 0.0, 1.0)
}

// Mirrors the device broadcast: a counter followed by a ring of [dry, output, sidechain, gain] entries.
export class DuckerHistory {
    static readonly Values = 4
    static readonly Entries = 64
    static readonly CounterWrap = 1 << 20

    readonly #capacity: int
    readonly #values: Float32Array
    #written: int
    #counter: int

    constructor(capacity: int) {
        this.#capacity = capacity
        this.#values = new Float32Array(capacity * DuckerHistory.Values)
        this.#values.fill(0.0)
        for (let index = 0; index < capacity; index++) {this.#values[index * DuckerHistory.Values + 3] = 1.0}
        this.#written = 0
        this.#counter = -1
    }

    get capacity(): int {return this.#capacity}

    receive(broadcast: Float32Array): int {
        const counter = broadcast[0]
        if (this.#counter < 0) {
            this.#counter = counter
            return 0
        }
        const fresh = Math.min((counter - this.#counter + DuckerHistory.CounterWrap) % DuckerHistory.CounterWrap,
            DuckerHistory.Entries)
        for (let back = fresh; back > 0; back--) {
            const entry = (counter - back + DuckerHistory.CounterWrap) % DuckerHistory.Entries
            const target = (this.#written % this.#capacity) * DuckerHistory.Values
            for (let value = 0; value < DuckerHistory.Values; value++) {
                this.#values[target + value] = broadcast[1 + entry * DuckerHistory.Values + value]
            }
            this.#written++
        }
        this.#counter = counter
        return fresh
    }

    // age 0 is the newest entry
    value(age: int, value: int): number {
        const index = ((this.#written - 1 - age) % this.#capacity + this.#capacity) % this.#capacity
        return this.#values[index * DuckerHistory.Values + value]
    }
}
