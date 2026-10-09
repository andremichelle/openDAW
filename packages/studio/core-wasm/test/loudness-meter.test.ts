// EBU Tech 3341 compliance of the Analysis panel's LoudnessMeter (issues 426, 427, 428).
import {describe, expect, it} from "vitest"
import {LoudnessMeter} from "../src/analysis-dsp"

const BLOCK = 128

const feed = (meter: LoudnessMeter, seconds: number, sampleRate: number,
              signal: (frame: number) => number, offset: number = 0): number => {
    const left = new Float32Array(BLOCK)
    const right = new Float32Array(BLOCK)
    const frames = Math.round(seconds * sampleRate)
    let frame = offset
    for (let start = 0; start < frames; start += BLOCK) {
        for (let i = 0; i < BLOCK; i++) {left[i] = right[i] = signal(frame++)}
        meter.process(left, right)
    }
    return frame
}

const read = (meter: LoudnessMeter) => {
    const out = new Float32Array(5)
    meter.fill(out)
    return {momentary: out[0], shortTerm: out[1], integrated: out[2], range: out[3], truePeak: out[4]}
}

const sine = (sampleRate: number, frequency: number, dbfs: number, phase: number = 0.0) => {
    const amplitude = 10 ** (dbfs / 20)
    return (frame: number) => amplitude * Math.sin(phase + 2.0 * Math.PI * frequency * frame / sampleRate)
}

// ITU-R BS.1770-4 Table 1 and 2: the printed 48 kHz pre-filter coefficients
const magnitude = (b: ReadonlyArray<number>, a: ReadonlyArray<number>, frequency: number, sampleRate: number): number => {
    const w = 2.0 * Math.PI * frequency / sampleRate
    const re = (c: ReadonlyArray<number>) => c[0] + c[1] * Math.cos(-w) + c[2] * Math.cos(-2 * w)
    const im = (c: ReadonlyArray<number>) => c[1] * Math.sin(-w) + c[2] * Math.sin(-2 * w)
    return Math.hypot(re(b), im(b)) / Math.hypot(re(a), im(a))
}
const kWeighting48k = (frequency: number): number =>
    magnitude([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585], frequency, 48000)
    * magnitude([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621], frequency, 48000)

describe("LoudnessMeter K-weighting (issue 426)", () => {
    for (const sampleRate of [48000, 44100]) {
        it(`EBU 3341 case 1: stereo 1 kHz at -23 dBFS reads -23.0 ±0.1 LUFS at ${sampleRate} Hz`, () => {
            const meter = new LoudnessMeter(sampleRate)
            feed(meter, 20, sampleRate, sine(sampleRate, 1000, -23))
            const {momentary, shortTerm, integrated} = read(meter)
            expect(integrated).toBeGreaterThan(-23.1)
            expect(integrated).toBeLessThan(-22.9)
            expect(momentary).toBeCloseTo(-23.0, 1)
            expect(shortTerm).toBeCloseTo(-23.0, 1)
        })
        it(`EBU 3341 case 2: stereo 1 kHz at -33 dBFS reads -33.0 ±0.1 LUFS at ${sampleRate} Hz`, () => {
            const meter = new LoudnessMeter(sampleRate)
            feed(meter, 20, sampleRate, sine(sampleRate, 1000, -33))
            const {integrated} = read(meter)
            expect(integrated).toBeGreaterThan(-33.1)
            expect(integrated).toBeLessThan(-32.9)
        })
    }
    for (const frequency of [100, 500, 1000, 1500, 2000, 3000, 5000, 10000]) {
        it(`follows the BS.1770 response at ${frequency} Hz (48 kHz)`, () => {
            const meter = new LoudnessMeter(48000)
            feed(meter, 5, 48000, sine(48000, frequency, -20))
            const expected = -0.691 + 10 * Math.log10(2 * 0.5 * (10 ** (-20 / 20) * kWeighting48k(frequency)) ** 2)
            expect(Math.abs(read(meter).momentary - expected), "momentary: no histogram bins").toBeLessThan(0.02)
        })
    }
})

describe("LoudnessMeter true peak (issue 427)", () => {
    const cases: ReadonlyArray<[string, number, number]> = [
        ["case 15: fs/4, 0°", 4, 0.0],
        ["case 16: fs/4, 45°", 4, 45.0],
        ["case 17: fs/6, 60°", 6, 60.0],
        ["case 18: fs/8, 67.5°", 8, 67.5]
    ]
    for (const sampleRate of [48000, 44100]) {
        for (const [name, divisor, degrees] of cases) {
            it(`EBU 3341 ${name} reads -6.0 dBTP (+0.2 / -0.4) at ${sampleRate} Hz`, () => {
                const meter = new LoudnessMeter(sampleRate)
                // a 10 ms fade-in: a step from silence legitimately overshoots in the interpolated signal
                const tone = sine(sampleRate, sampleRate / divisor, -6.0206, degrees * Math.PI / 180)
                const fade = Math.round(sampleRate * 0.01)
                feed(meter, 1, sampleRate, frame => tone(frame) * Math.min(1.0, frame / fade))
                const {truePeak} = read(meter)
                expect(truePeak).toBeGreaterThanOrEqual(-6.4)
                expect(truePeak).toBeLessThanOrEqual(-5.8)
            })
        }
    }
})

describe("LoudnessMeter reset (issue 428)", () => {
    it("a reset starts a new measurement: nothing of the previous signal remains", () => {
        const sampleRate = 48000
        const meter = new LoudnessMeter(sampleRate)
        feed(meter, 10, sampleRate, sine(sampleRate, 1000, -10))
        meter.reset()
        expect(read(meter)).toEqual({momentary: -120, shortTerm: -120, integrated: -120, range: 0, truePeak: -120})
        feed(meter, 20, sampleRate, sine(sampleRate, 1000, -33))
        const {integrated, truePeak} = read(meter)
        expect(integrated).toBeCloseTo(-33.0, 1)
        expect(truePeak).toBeLessThan(-32)
    })

    it("a reset meter reads like a new one", () => {
        const sampleRate = 48000
        const fresh = new LoudnessMeter(sampleRate)
        const reused = new LoudnessMeter(sampleRate)
        feed(reused, 7.37, sampleRate, sine(sampleRate, 440, -3))
        reused.reset()
        const signal = sine(sampleRate, 1000, -23)
        feed(fresh, 4, sampleRate, signal)
        feed(reused, 4, sampleRate, signal)
        expect(read(reused)).toEqual(read(fresh))
    })
})
