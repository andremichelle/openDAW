import {Arrays, clamp, Func, int} from "@opendaw/lib-std"

// The loops of Surgeon as the engine computes them (`crates/stock-devices/device-surgeon`), so the editor draws
// what plays. Every roll must match the engine's, in 32 bit float.
export namespace SurgeonModel {
    export const Lanes = 4
    export const MaxSteps = 32
    export const PatternCount = 8
    export const Rates: ReadonlyArray<string> = ["1/8", "1/16", "1/32"]
    export const RatePulses: ReadonlyArray<number> = [480, 240, 120]
    export const BarPulses = 3840

    export enum Kind {Play, Tie, Rest}

    export type PitchLoop = { steps: int, seed: int, mutate: number, range: number, density: number, tie: number, accent: number }
    export type Lane = { steps: int, seed: int, mutate: number }
    export type Step = { readonly offset: number, readonly velocity: number, readonly kind: Kind }
    export type Pattern = {
        readonly pitch: PitchLoop
        readonly lanes: Array<Lane>
        readonly base: Array<number>
        readonly amounts: Array<Array<number>>
        rate: int
    }
    export type Param = {
        readonly name: string
        readonly min: number
        readonly max: number
        readonly exponential: boolean
        readonly choices?: ReadonlyArray<string>
    }

    const linear = (name: string, min: number, max: number): Param => ({name, min, max, exponential: false})
    const exponential = (name: string, min: number, max: number): Param => ({name, min, max, exponential: true})
    const choice = (name: string, choices: ReadonlyArray<string>): Param =>
        ({name, min: 0.0, max: choices.length, exponential: false, choices})

    export const Params: ReadonlyArray<Param> = [
        exponential("Ratio 1", 0.25, 8.0),
        linear("Feedback", 0.0, 1.0),
        exponential("Ratio 2", 0.25, 16.0),
        linear("Depth 2", 0.0, 1.5),
        choice("Wave", ["Sine", "Half", "Rect", "Burst"]),
        linear("Depth", 0.0, 4.0),
        linear("Strike", 0.0, 8.0),
        exponential("Strike Dec", 0.02, 1.0),
        linear("Fold", 0.0, 1.0),
        choice("Fold Place", ["Before", "After"]),
        linear("Length", 0.0, 1.0),
        linear("Held", 0.0, 1.0),
        linear("Sine", 0.0, 1.5),
        choice("Sine Pitch", ["-1 oct", "Pitch"]),
        linear("Glide", 0.0, 0.3),
        linear("Velocity", 0.0, 1.0)
    ]
    export const Index = {
        Ratio1: 0, Feedback: 1, Ratio2: 2, Depth2: 3, Wave: 4, Depth: 5, Strike: 6, StrikeDecay: 7,
        Fold: 8, FoldPlace: 9, Length: 10, HeldShare: 11, SineLevel: 12, SinePitch: 13, Glide: 14, Velocity: 15
    } as const

    const float = Math.fround
    const mix = (input: int): int => {
        let value = input >>> 0
        value ^= value >>> 16
        value = Math.imul(value, 0x7FEB352D) >>> 0
        value ^= value >>> 15
        value = Math.imul(value, 0x846CA68B) >>> 0
        return (value ^ (value >>> 16)) >>> 0
    }

    // a stable 0 to 1 value for a seed and three indices
    export const unit = (seed: int, first: int, second: int, third: int): number => {
        const hashed = mix((mix((mix((mix(seed) ^ first) >>> 0) + second) >>> 0) ^ Math.imul(third, 0x9E3779B9)) >>> 0)
        return (hashed >>> 8) / 0x1000000
    }

    // how often a step has been replaced after `pass` passes
    export const generation = (seed: int, step: int, pass: int, mutate: number): int => {
        const chance = float(mutate)
        let count = 0
        for (let index = 1; index <= pass; index++) {
            if (unit(seed, step, index, 0) < chance) {count++}
        }
        return count
    }

    export const step = ({steps, seed, mutate, range, density, tie, accent}: PitchLoop, position: int): Step => {
        const length = clamp(steps, 1, MaxSteps)
        const index = position % length
        const replaced = generation(seed, index, Math.floor(position / length), mutate)
        const roll: Func<int, number> = channel => unit(seed, index, replaced, channel)
        const kind = roll(2) >= float(density) ? Kind.Rest : roll(3) < float(tie) ? Kind.Tie : Kind.Play
        const offset = float(float(float(roll(1) * 2.0) - 1.0) * float(range))
        return {offset, velocity: float(1.0 - float(float(accent) * roll(4))), kind}
    }

    export const laneValue = ({steps, seed, mutate}: Lane, position: int): number => {
        const length = clamp(steps, 1, MaxSteps)
        const index = position % length
        return unit(seed, index, generation(seed, index, Math.floor(position / length), mutate), 1)
    }

    export const valueOf = ({min, max, exponential}: Param, position: number): number =>
        float(exponential ? min * Math.pow(max / min, position) : min + (max - min) * position)

    export const unitOf = ({min, max, exponential}: Param, value: number): number =>
        float(exponential ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min))

    // the parameter's 0 to 1 position at a step: base plus what the lanes add, limited to the range
    export const unitAt = ({lanes, base, amounts}: Pattern, param: int, position: int): number => {
        let added = 0.0
        lanes.forEach((lane, index) => added = float(added + float(float(amounts[param][index]) * laneValue(lane, position))))
        return clamp(float(float(base[param]) + added), 0.0, 1.0)
    }

    const setValue = (pattern: Pattern, param: int, value: number): void => {
        const offset = Params[param].choices === undefined ? 0.0 : 0.5
        pattern.base[param] = unitOf(Params[param], float(value + offset))
    }

    const map = (pattern: Pattern, param: int, lane: int, from: number, to: number): void => {
        const start = unitOf(Params[param], from)
        pattern.base[param] = start
        pattern.amounts[param][lane] = float(unitOf(Params[param], to) - start)
    }

    export const create = (pitch: PitchLoop, lanes: Array<Lane>): Pattern => {
        const pattern: Pattern = {
            pitch, lanes, rate: 1,
            base: Arrays.create(() => 0.0, Params.length),
            amounts: Arrays.create(() => Arrays.create(() => 0.0, Lanes), Params.length)
        }
        setValue(pattern, Index.Ratio1, 2.41)
        setValue(pattern, Index.Feedback, 0.25)
        setValue(pattern, Index.Ratio2, 5.19)
        setValue(pattern, Index.Depth, 0.6)
        setValue(pattern, Index.Strike, 4.0)
        setValue(pattern, Index.StrikeDecay, 0.14)
        setValue(pattern, Index.Length, 0.7)
        setValue(pattern, Index.Glide, 0.04)
        setValue(pattern, Index.Velocity, 0.7)
        return pattern
    }

    // Random all: must draw exactly like the engine's `Pattern::random`
    export const random = (seed: int): Pattern => {
        const roll: Func<int, number> = index => unit(seed, index, 0, 7)
        const between = (index: int, low: number, high: number): number => float(low + float(float(high - low) * roll(index)))
        const pitch: PitchLoop = {
            steps: Math.trunc(between(0, 3.0, 17.0)),
            seed: Math.trunc(float(roll(1) * 100_000.0)),
            mutate: between(2, 0.04, 0.25),
            range: between(3, 5.0, 19.0),
            density: between(4, 0.55, 0.95),
            tie: between(5, 0.0, 0.4),
            accent: between(6, 0.3, 0.8)
        }
        const lane: Func<int, Lane> = index => ({
            steps: Math.trunc(between(10 + index, 2.0, 17.0)),
            seed: Math.trunc(float(roll(20 + index) * 100_000.0)),
            mutate: between(30 + index, 0.05, 0.3)
        })
        const pattern = create(pitch, Arrays.create(lane, Lanes))
        setValue(pattern, Index.Ratio1, float(0.5 * float(Math.pow(12.0, roll(40)))))
        setValue(pattern, Index.Ratio2, float(Math.pow(12.0, roll(41))))
        setValue(pattern, Index.Depth2, between(42, 0.0, 1.0))
        setValue(pattern, Index.Wave, Math.min(Math.floor(float(roll(43) * 4.0)), 3.0))
        setValue(pattern, Index.Depth, between(44, 0.2, 1.4))
        setValue(pattern, Index.StrikeDecay, float(0.06 * float(Math.pow(5.0, roll(45)))))
        setValue(pattern, Index.FoldPlace, Math.min(Math.floor(float(roll(46) * 2.0)), 1.0))
        setValue(pattern, Index.HeldShare, between(47, 0.0, 0.15))
        setValue(pattern, Index.SineLevel, between(48, 0.3, 0.9))
        setValue(pattern, Index.SinePitch, Math.min(Math.floor(float(roll(49) * 2.0)), 1.0))
        setValue(pattern, Index.Glide, between(50, 0.01, 0.08))
        setValue(pattern, Index.Velocity, between(51, 0.4, 1.0))
        const pick: Func<int, int> = index => Math.min(Math.trunc(float(roll(index) * Lanes)), Lanes - 1)
        map(pattern, Index.Feedback, pick(60), between(61, 0.0, 0.3), between(62, 0.4, 0.9))
        map(pattern, Index.Strike, pick(63), between(64, 0.5, 2.5), between(65, 4.0, 8.0))
        map(pattern, Index.Length, pick(66), between(67, 0.0, 0.3), between(68, 0.7, 1.0))
        map(pattern, Index.Fold, pick(69), 0.0, between(70, 0.0, 0.6))
        const extras: ReadonlyArray<int> = [Index.Depth2, Index.SineLevel, Index.StrikeDecay, Index.Depth, Index.Feedback, Index.Fold]
        extras.forEach((param, order) => {
            const index = 80 + order * 4
            if (roll(index) < float(0.4)) {
                const target = pick(index + 1)
                pattern.amounts[param][target] = float(pattern.amounts[param][target] + between(index + 2, -0.35, 0.35))
            }
        })
        return pattern
    }

    // the favourite of the listening rounds
    export const favourite = (): Pattern => {
        const pattern = create({steps: 7, seed: 1, mutate: 0.12, range: 13.0, density: 0.8, tie: 0.25, accent: 0.6}, [
            {steps: 5, seed: 21, mutate: 0.15}, {steps: 9, seed: 22, mutate: 0.15},
            {steps: 4, seed: 23, mutate: 0.15}, {steps: 11, seed: 24, mutate: 0.15}])
        setValue(pattern, Index.Wave, 2.0)
        setValue(pattern, Index.SineLevel, 0.6)
        setValue(pattern, Index.Depth2, 0.6)
        setValue(pattern, Index.HeldShare, 0.08)
        map(pattern, Index.Feedback, 0, 0.0, 0.8)
        map(pattern, Index.Strike, 1, 1.0, 7.0)
        map(pattern, Index.Fold, 2, 0.0, 0.5)
        map(pattern, Index.Length, 3, 0.0, 1.0)
        return pattern
    }

    export const copy = ({pitch, lanes, base, amounts, rate}: Pattern): Pattern => ({
        pitch: {...pitch}, lanes: lanes.map(lane => ({...lane})), base: base.slice(), amounts: amounts.map(row => row.slice()), rate
    })
}
