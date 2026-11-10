import {ppqn} from "./ppqn"
import {assert, Bijective, BinarySearch, FloatArray, NumberComparator, quantizeFloor, unitValue} from "@opendaw/lib-std"

export interface GrooveFunction extends Bijective<unitValue, unitValue> {}

export interface GroovePatternFunction extends GrooveFunction {
    duration(): ppqn
}

export interface Groove {
    warp(position: ppqn): ppqn
    unwarp(position: ppqn): ppqn
}

export namespace Groove {
    export const Identity: Groove = {
        warp: (position: ppqn): ppqn => position,
        unwarp: (position: ppqn): ppqn => position
    }
}

export class GroovePattern implements Groove {
    readonly #func: GroovePatternFunction

    constructor(func: GroovePatternFunction) {this.#func = func}

    warp(position: ppqn): ppqn {return this.#transform(true, position)}
    unwarp(position: ppqn): ppqn {return this.#transform(false, position)}

    #transform(forward: boolean, position: ppqn): ppqn {
        const duration = this.#func.duration()
        if (duration <= 0) {return position}
        const start = quantizeFloor(position, duration)
        const normalized = (position - start) / duration
        const transformed = forward ? this.#func.fx(normalized) : this.#func.fy(normalized)
        return start + transformed * duration
    }
}

export class QuantisedGrooveFunction implements GrooveFunction {
    readonly #values: FloatArray

    constructor(values: FloatArray) {
        assert(values.length >= 2, "Must have at least two values [0, 1]")
        assert(values[0] === 0.0, "First entry must be zero")
        assert(values[values.length - 1] === 1.0, "Last entry must be one")
        this.#values = values
    }

    fx(x: unitValue): unitValue {
        if (x <= 0.0) {return 0.0}
        if (x >= 1.0) {return 1.0}
        const idxFloat = x * (this.#values.length - 1)
        const idxInteger = idxFloat | 0
        const valueFloor = this.#values[idxInteger]
        const alpha = idxFloat - idxInteger
        return valueFloor + alpha * (this.#values[idxInteger + 1] - valueFloor)
    }

    fy(y: unitValue): unitValue {
        if (y <= 0.0) {return 0.0}
        if (y >= 1.0) {return 1.0}
        const index = BinarySearch.rightMost(this.#values as unknown as ReadonlyArray<number>, y, NumberComparator)
        const curr = this.#values[index]
        const next = this.#values[index + 1]
        const alpha = (y - curr) / (next - curr)
        return (index + alpha) / (this.#values.length - 1)
    }
}

export class GrooveChain implements Groove {
    readonly #grooves: ReadonlyArray<Groove>

    constructor(grooves: ReadonlyArray<Groove>) {this.#grooves = grooves}

    warp(position: ppqn): ppqn {
        for (let i = 0; i < this.#grooves.length; i++) {position = this.#grooves[i].warp(position)}
        return position
    }

    unwarp(position: ppqn): ppqn {
        for (let i = this.#grooves.length - 1; i >= 0; i--) {position = this.#grooves[i].unwarp(position)}
        return position
    }
}
export namespace GrooveCurves {
    const Exponent = 4.0
    const InverseExponent = 1.0 / Exponent
    const BisectIterations = 52

    // Pushes positions towards the end of the cell
    export const Power: GrooveFunction = {
        fx: (phase: unitValue): unitValue => 1.0 - Math.pow(1.0 - phase, Exponent),
        fy: (value: unitValue): unitValue => 1.0 - Math.pow(1.0 - value, InverseExponent)
    }

    // Pulls positions towards the middle of the cell
    export const SCurve: GrooveFunction = {
        fx: (phase: unitValue): unitValue => phase < 0.5
            ? 0.5 - 0.5 * Math.pow(1.0 - 2.0 * phase, Exponent)
            : 0.5 + 0.5 * Math.pow(2.0 * phase - 1.0, Exponent),
        fy: (value: unitValue): unitValue => value < 0.5
            ? 0.5 - 0.5 * Math.pow(1.0 - 2.0 * value, InverseExponent)
            : 0.5 + 0.5 * Math.pow(2.0 * value - 1.0, InverseExponent)
    }

    export const randomUnit = (seed: number, index: number): unitValue => {
        let hash = Math.imul(seed, 0x9E3779B1) ^ Math.imul(index, 0x85EBCA77)
        hash = Math.imul(hash ^ (hash >>> 15), 0x2545F491)
        hash ^= hash >>> 13
        return (hash >>> 0) / 4294967295.0
    }

    // A monotonic random sequence from 0 to 1 with steps + 1 entries
    export const randomValues = (seed: number, steps: number, roughness: unitValue): Float64Array => {
        const count = Math.max(1, Math.floor(steps))
        const scale = 1.0 + roughness * 15.0
        const values = new Float64Array(count + 1)
        let sum = 0.0
        for (let index = 1; index <= count; index++) {
            const delta = Math.floor(randomUnit(seed, index) * scale) + 1.0
            sum += delta
            values[index] = sum
        }
        for (let index = 1; index < count; index++) {values[index] /= sum}
        values[count] = 1.0
        return values
    }

    // Keeps a blend invertible where a curve flattens (like the shuffle's squashUnit margin)
    const MaxWeight = 0.98

    // 50% is straight, 100% the function, 0% its mirror on y = x (the inverse of the blend at 100% minus the amount)
    export const blend = (func: GrooveFunction, amount: unitValue): GrooveFunction => {
        const weight = Math.min(1.0, Math.abs(2.0 * amount - 1.0)) * MaxWeight
        const forward = (phase: unitValue): unitValue => {
            if (phase <= 0.0) {return 0.0}
            if (phase >= 1.0) {return 1.0}
            return phase + weight * (func.fx(phase) - phase)
        }
        const inverse = (value: unitValue): unitValue => {
            if (value <= 0.0) {return 0.0}
            if (value >= 1.0) {return 1.0}
            let low = 0.0
            let high = 1.0
            for (let iteration = 0; iteration < BisectIterations; iteration++) {
                const middle = (low + high) * 0.5
                if (forward(middle) < value) {low = middle} else {high = middle}
            }
            return (low + high) * 0.5
        }
        return amount >= 0.5 ? {fx: forward, fy: inverse} : {fx: inverse, fy: forward}
    }
}
