import {asDefined, assert, int, panic, unitValue} from "./lang"
import {clamp} from "./math"
import {Integer} from "./numeric"

export interface ValueMapping<Y> {
    y(x: unitValue): Y
    x(y: Y): unitValue
    clamp(y: Y): Y
    floating(): boolean
}

class Linear implements ValueMapping<number> {
    readonly #min: number
    readonly #max: number
    readonly #range: number

    constructor(min: number, max: number) {
        assert(min < max, "Linear is inverse")
        this.#min = min
        this.#max = max
        this.#range = max - min
    }
    x(y: number): unitValue {return y <= this.#min ? 0.0 : y >= this.#max ? 1.0 : (y - this.#min) / this.#range}
    y(x: unitValue): number {return x <= 0.0 ? this.#min : x >= 1.0 ? this.#max : this.#min + x * this.#range}
    clamp(y: number): number {return clamp(y, this.#min, this.#max)}
    floating(): boolean {return true}
}

class LinearInteger implements ValueMapping<int> {
    readonly #min: int
    readonly #max: int
    readonly #range: int

    constructor(min: int, max: int) {
        this.#min = clamp(Math.round(min), Integer.MIN_VALUE, Integer.MAX_VALUE)
        this.#max = clamp(Math.round(max), Integer.MIN_VALUE, Integer.MAX_VALUE)
        this.#range = this.#max - this.#min
    }
    x(y: int): unitValue {return (this.clamp(y) - this.#min) / this.#range}
    y(x: unitValue): int {return this.#min + Math.round(clamp(x, 0.0, 1.0) * this.#range)}
    clamp(y: int): int {return clamp(Math.round(y), this.#min, this.#max)}
    floating(): boolean {return false}
}

class Exponential implements ValueMapping<number> {
    readonly #min: number
    readonly #max: number
    readonly #range: number

    constructor(min: number, max: number) {
        assert(min < max, "Exponential is inverse")
        this.#min = min
        this.#max = max
        this.#range = Math.log(max / min)
    }
    x(y: number): unitValue {
        return y <= this.#min ? 0.0 : y >= this.#max ? 1.0 : Math.log(y / this.#min) / this.#range
    }
    y(x: unitValue): number {
        return x <= 0.0 ? this.#min : x >= 1.0 ? this.#max : Math.exp(x * this.#range) * this.#min
    }
    clamp(y: number): number {return Math.min(this.#max, Math.max(this.#min, y))}
    floating(): boolean {return true}
}

class Values<T> implements ValueMapping<T> {
    readonly #values: ReadonlyArray<T>

    constructor(values: ReadonlyArray<T>) {
        this.#values = values
    }
    x(y: T): unitValue {
        const index = this.#values.findIndex(value => value === y)
        return index === -1
            ? panic(`Could not find index for ${y}`)
            : index / (this.#values.length - 1)
    }
    y(x: unitValue): T {
        const index = Math.round(clamp(x, 0.0, 1.0) * (this.#values.length - 1))
        return index > -1
            ? asDefined(this.#values.at(index), `Could not find value for ${x}`)
            : panic(`Index ${index} is out of box.`)
    }
    clamp(y: T): T {return y}
    floating(): boolean {return false}
}

class Decibel implements ValueMapping<number> {
    readonly #min: number
    readonly #max: number
    readonly #a: number
    readonly #b: number
    readonly #c: number

    /**
     * @param min The lowest decibel value
     * @param mid The decibel value in the center
     * @param max The highest decibel value
     */
    constructor(min: number, mid: number, max: number) {
        this.#min = min
        this.#max = max
        const min2 = min * min
        const max2 = max * max
        const mid2 = mid * mid
        const tmp0 = min + max - 2.0 * mid
        const tmp1 = max - mid
        this.#a = ((2.0 * max - mid) * min - mid * max) / tmp0
        this.#b = (tmp1 * min2 + (mid2 - max2) * min + mid * max2 - mid2 * max)
            / (min2 + (2.0 * max - 4.0 * mid) * min + max2 - 4.0 * mid * max + 4.0 * mid2)
        this.#c = -tmp1 / tmp0
    }

    y(x: number): number {
        if (x <= 0.0) {return Number.NEGATIVE_INFINITY}
        if (x >= 1.0) {return this.#max}
        return this.#a - this.#b / (x + this.#c)
    }

    x(y: number): number {
        if (this.#min >= y) {return 0.0}
        if (this.#max <= y) {return 1.0}
        return -this.#b / (y - this.#a) - this.#c
    }

    clamp(y: number): number {return Math.min(this.#max, y)}
    floating(): boolean {return true}
}

export namespace ValueMapping {
    export const linear = (min: number, max: number): ValueMapping<number> => new Linear(min, max)
    export const linearInteger = (min: int, max: int): ValueMapping<int> => new LinearInteger(min, max)
    export const exponential = (min: number, max: number): ValueMapping<number> => new Exponential(min, max)
    export const values = <T>(values: ReadonlyArray<T>): ValueMapping<T> => new Values<T>(values)
    export const decibel = (min: number, mid: number, max: number): ValueMapping<number> => new Decibel(min, mid, max)
    const Bool = new class implements ValueMapping<boolean> {
        x(y: boolean): unitValue {return y ? 1.0 : 0.0}
        y(x: unitValue): boolean {return x >= 0.5}
        clamp(y: boolean): boolean {return y}
        floating(): boolean {return false}
    }
    const Unipolar = linear(0.0, 1.0)
    const Bipolar = linear(-1.0, 1.0)
    export const bool = Bool
    const DefaultDecibelInstance = decibel(-72.0, -12.0, 0.0)

    export const unipolar = (): ValueMapping<number> => Unipolar
    export const bipolar = (): ValueMapping<number> => Bipolar
    export const DefaultDecibel = DefaultDecibelInstance
}