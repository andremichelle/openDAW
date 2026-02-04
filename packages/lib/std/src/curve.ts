import {int, Procedure, unitValue} from "./lang"
import {clamp} from "./math"

/**
 * original: http://werner.yellowcouch.org/Papers/fastenv12/index.html
 */
export namespace Curve {
    export interface Definition {
        slope: unitValue
        steps: int
        y0: number
        y1: number
    }

    export interface Coefficients {
        m: number
        q: number
    }

    const EPLISON = 1.0e-15 as const

    export const valueAt = ({slope, steps, y0, y1}: Definition, x: number): number =>
        normalizedAt(x / steps, slope) * (y1 - y0) + y0

    // https://www.desmos.com/calculator/9lwjajcfkw
    export const normalizedAt = (x: unitValue, slope: unitValue): unitValue => {
        if (slope > 0.499999 && slope < 0.500001) {
            return x
        } else {
            const p = clamp(slope, EPLISON, 1.0 - EPLISON)
            return (p * p) / (1.0 - p * 2.0) * (Math.pow((1.0 - p) / p, 2.0 * x) - 1.0)
        }
    }

    export const inverseAt = (y: unitValue, slope: unitValue): unitValue => {
        const p = clamp(slope, EPLISON, 1.0 - EPLISON)
        return Math.log((y * (1.0 - 2.0 * p) / (p * p)) + 1.0) / (2.0 * Math.log((1.0 - p) / p))
    }

    export const coefficients = (definition: Definition): Coefficients => {
        const f1 = valueAt(definition, 1.0)
        const f2 = valueAt(definition, 2.0)
        const m = (f2 - f1) / (f1 - definition.y0)
        const q = f1 - m * definition.y0
        return {m, q}
    }

    export function* walk(slope: number, steps: int, y0: number, y1: number): IterableIterator<number> {
        const {m, q} = coefficients({slope, steps, y0, y1} satisfies Curve.Definition)
        for (let i = 0, v = y0; i < steps; i++) {yield v = m * v + q}
    }

    export const run = (slope: number, steps: int, y0: number, y1: number, runner: Procedure<number>): void => {
        const {m, q} = coefficients({slope, steps, y0, y1} satisfies Curve.Definition)
        for (let i = 0, v = y0; i < steps; i++) {runner(v = m * v + q)}
    }

    export function* walkNormalized(slope: number, steps: int): IterableIterator<unitValue> {
        const d = 1.0 / steps
        const f1 = normalizedAt(d, slope)
        const f2 = normalizedAt(2.0 * d, slope)
        const m = (f2 - f1) / f1
        for (let i = 0, v = 0.0; i < steps; i++) {yield v = m * v + f1}
    }

    export const byHalf = (steps: number, y0: number, ym: number, y1: number): Definition => ({
        slope: slopeByHalf(y0, ym, y1), steps, y0, y1
    })

    export const slopeByHalf = (y0: number, ym: number, y1: number): number =>
        Math.abs(y1 - y0) < 1e-6 ? 0.5 : (ym - y0) / (y1 - y0)
}