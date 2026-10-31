// Loads the built matchering.wasm and compares it to Matchering 2.0.6 on the audio of crates/matchering/tests/stages.rs.
// The input is f32 here, the fixtures were computed from f64, so the tolerance is wider than in the Rust tests.
import {describe, expect, it} from "vitest"
import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import {MatcheringWasm} from "../src/MatcheringWasm"
import {Matchering} from "../src/Matchering"

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))
const fixture = (name: string): Float64Array => {
    const bytes = readFileSync(here(`../../../../crates/matchering/tests/fixtures/${name}.bin`))
    return new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

const MASK = (1n << 64n) - 1n
const noise = (seed: bigint, index: bigint): number => {
    let z = (seed + index * 0x9E3779B97F4A7C15n) & MASK
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK
    z = z ^ (z >> 31n)
    return Number(z >> 11n) / 2 ** 53 * 2.0 - 1.0
}

const signal = (seconds: number, seed: number, tones: ReadonlyArray<[number, number]>,
                noiseLevel: number): [Float32Array, Float32Array] => {
    const count = Math.floor(seconds * Matchering.SampleRate)
    const channel = (channel: number): Float32Array => {
        const output = new Float32Array(count)
        for (let index = 0; index < count; index++) {
            const t = index / Matchering.SampleRate
            const envelope = 0.5 + 0.4 * Math.sin(2.0 * Math.PI * 0.07 * t)
            const voice = tones.reduce((sum, [frequency, level]) =>
                sum + level * Math.sin(2.0 * Math.PI * frequency * t + channel * 0.3), 0.0)
            output[index] = envelope * (voice + noiseLevel * noise(BigInt(seed + channel), BigInt(index)))
        }
        return output
    }
    return [channel(0), channel(1)]
}

const maxDeviation = (actual: ArrayLike<number>, expected: ArrayLike<number>, from: number = 0): number => {
    let worst = 0.0
    for (let index = from; index < expected.length; index++) {
        worst = Math.max(worst, Math.abs(actual[index] - expected[index]) / Math.max(1.0, Math.abs(expected[index])))
    }
    return worst
}

describe("matchering.wasm", async () => {
    const stages: Array<Matchering.Stage> = []
    const wasm = await MatcheringWasm.instantiate(readFileSync(here("../dist/matchering.wasm")), stage => stages.push(stage))
    const [referenceLeft, referenceRight] = signal(35.0, 11, [[80.0, 0.4], [2000.0, 0.25]], 0.1)
    const [targetLeft, targetRight] = signal(40.0, 7, [[110.0, 0.3], [440.0, 0.2]], 0.15)
    it("analyses the reference like Matchering", () => {
        const profile = wasm.analyseReference(referenceLeft, referenceRight)
        expect(maxDeviation([profile.matchRms, profile.finalAmplitude], fixture("profile_scalars"))).toBeLessThan(1e-6)
        expect(maxDeviation(profile.midSpectrum, fixture("profile_mid_spectrum"))).toBeLessThan(1e-6)
        expect(maxDeviation(profile.sideSpectrum, fixture("profile_side_spectrum"))).toBeLessThan(1e-6)
    })
    it("matches the target like Matchering and reports the stages in order", () => {
        stages.length = 0
        const result = wasm.matchTarget(targetLeft, targetRight, wasm.analyseReference(referenceLeft, referenceRight))
        expect(maxDeviation(result.midCurve, fixture("match_mid_curve"), 2)).toBeLessThan(1e-5)
        expect(maxDeviation(result.sideCurve, fixture("match_side_curve"), 2)).toBeLessThan(1e-5)
        expect(Number.isFinite(result.gain) && result.gain > 0.0).toBe(true)
        expect(stages).toEqual(["levels", "frequencies", "correction"])
    })
    it("rejects audio shorter than one FFT frame", () => {
        const short = new Float32Array(4096)
        expect(() => wasm.analyseReference(short, short)).toThrow(/too short/)
    })
    it("keeps working after a failed call and with grown memory", () => {
        const [left, right] = signal(120.0, 3, [[220.0, 0.3]], 0.2)
        const profile = wasm.analyseReference(left, right)
        expect(Number.isFinite(profile.matchRms)).toBe(true)
    })
})
