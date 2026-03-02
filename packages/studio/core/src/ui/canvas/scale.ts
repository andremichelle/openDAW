import {unitValue} from "@opendaw/lib-std"

export interface Scale {
    unitToNorm(unit: number): unitValue
    normToUnit(norm: unitValue): number
}

export class LinearScale implements Scale {
    readonly #min: number
    readonly #max: number
    readonly #range: number
    readonly #rangeInv: number

    constructor(min: number, max: number) {
        this.#min = min
        this.#max = max
        this.#range = max - min
        this.#rangeInv = 1.0 / this.#range
    }

    get min(): number {return this.#min}
    get max(): number {return this.#max}

    normToUnit(norm: number): number {return this.#min + norm * this.#range}
    unitToNorm(unit: number): number {return (unit - this.#min) * this.#rangeInv}
}

export class LogScale implements Scale {
    readonly #min: number
    readonly #max: number
    readonly #range: number
    readonly #logMin: number
    readonly #logRangeInv: number

    constructor(min: number, max: number) {
        this.#min = min
        this.#max = max
        this.#range = Math.log(max / min)
        this.#logMin = Math.log(min)
        this.#logRangeInv = 1.0 / (Math.log(max) - this.#logMin)
    }

    get min(): number {return this.#min}
    get max(): number {return this.#max}

    normToUnit(norm: unitValue): number {return this.#min * Math.exp(norm * this.#range)}
    unitToNorm(unit: number): unitValue {return (Math.log(unit) - this.#logMin) * this.#logRangeInv}
}