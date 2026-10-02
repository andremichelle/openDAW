// EBU Tech 3341 / 3342 minimum-requirements signals against LoudnessMeter
import {describe, expect, it} from "vitest"
import {LoudnessMeter} from "../src/analysis-dsp"

const QUANTUM = 128
const LEAD_SECONDS = 1.0
const TAIL_SECONDS = 0.3
const RATES = [48000, 44100]
const HALF_SCALE_DB = 20.0 * Math.log10(0.5)

type Segment = { db: number, seconds: number, hz?: number, rateDivisor?: number, phaseDeg?: number }
type Reading = { momentaryMax: number, shortTermMax: number, shortTerm: number, integrated: number, range: number, truePeak: number }

const synthesize = (sampleRate: number, segments: ReadonlyArray<Segment>, taperSeconds: number = 0.0): Float32Array => {
    const total = segments.reduce((sum, segment) => sum + Math.round(segment.seconds * sampleRate), 0)
    const signal = new Float32Array(total)
    let offset = 0
    let phase = 0.0
    let previousHz = -1.0
    for (const segment of segments) {
        const hz = segment.rateDivisor === undefined ? segment.hz ?? 1000.0 : sampleRate / segment.rateDivisor
        const frames = Math.round(segment.seconds * sampleRate)
        const step = 2.0 * Math.PI * hz / sampleRate
        const gain = Math.pow(10.0, segment.db / 20.0)
        if (hz !== previousHz) {phase = (segment.phaseDeg ?? 0.0) * Math.PI / 180.0}
        for (let i = 0; i < frames; i++) {signal[offset + i] = gain * Math.sin(phase + i * step)}
        phase += frames * step
        previousHz = hz
        offset += frames
    }
    const taper = Math.round(taperSeconds * sampleRate)
    for (let i = 0; i < taper; i++) {
        signal[i] *= i / taper
        signal[total - 1 - i] *= i / taper
    }
    return signal
}

const measure = (sampleRate: number, signal: Float32Array): Reading => {
    const lead = Math.round(LEAD_SECONDS * sampleRate)
    const output = new Float32Array(lead + signal.length + Math.round(TAIL_SECONDS * sampleRate))
    output.set(signal, lead)
    const meter = new LoudnessMeter(sampleRate)
    const values = new Float32Array(5)
    let momentaryMax = -Infinity
    let shortTermMax = -Infinity
    for (let i = 0; i + QUANTUM <= output.length; i += QUANTUM) {
        meter.process(output.subarray(i, i + QUANTUM), output.subarray(i, i + QUANTUM))
        meter.fill(values)
        momentaryMax = Math.max(momentaryMax, values[0])
        shortTermMax = Math.max(shortTermMax, values[1])
    }
    return {momentaryMax, shortTermMax, shortTerm: values[1], integrated: values[2], range: values[3], truePeak: values[4]}
}

const tone = (db: number, seconds: number): Segment => ({db, seconds})

describe.each(RATES)("LoudnessMeter at %i Hz", sampleRate => {
    describe("EBU Tech 3341 loudness, +-0.1 LU", () => {
        it.each([[1, -23.0], [2, -33.0]])("case %i: a 20 s tone reads its level on M, S and I", (_case, level) => {
            const reading = measure(sampleRate, synthesize(sampleRate, [tone(level, 20.0)]))
            expect(Math.abs(reading.integrated - level)).toBeLessThanOrEqual(0.1)
            expect(Math.abs(reading.momentaryMax - level)).toBeLessThanOrEqual(0.1)
            expect(Math.abs(reading.shortTermMax - level)).toBeLessThanOrEqual(0.1)
        })
        it.each([
            [3, [tone(-36.0, 10.0), tone(-23.0, 60.0), tone(-36.0, 10.0)]],
            [4, [tone(-72.0, 10.0), tone(-36.0, 10.0), tone(-23.0, 60.0), tone(-36.0, 10.0), tone(-72.0, 10.0)]],
            [5, [tone(-26.0, 20.0), tone(-20.0, 20.1), tone(-26.0, 20.0)]]
        ])("case %i: the gates leave the integrated loudness at -23.0", (_case, segments) => {
            const reading = measure(sampleRate, synthesize(sampleRate, segments))
            expect(Math.abs(reading.integrated + 23.0)).toBeLessThanOrEqual(0.1)
        })
    })

    describe("EBU Tech 3342 loudness range, +-1 LU", () => {
        it.each([
            [1, [-20.0, -30.0], 10.0],
            [2, [-20.0, -15.0], 5.0],
            [3, [-40.0, -20.0], 20.0],
            [4, [-50.0, -35.0, -20.0, -35.0, -50.0], 15.0]
        ])("case %i", (_case, levels, expected) => {
            const reading = measure(sampleRate, synthesize(sampleRate, levels.map(level => tone(level, 20.0))))
            expect(Math.abs(reading.range - expected)).toBeLessThanOrEqual(1.0)
        })
    })

    describe("EBU Tech 3341 true peak, -6.0 dBTP +0.2 / -0.4", () => {
        it.each([[15, 4, 0.0], [16, 4, 45.0], [17, 6, 60.0], [18, 8, 67.5]])(
            "case %i: fs/%i at %f degrees", (_case, rateDivisor, phaseDeg) => {
                const signal = synthesize(sampleRate, [{db: HALF_SCALE_DB, seconds: 5.0, rateDivisor, phaseDeg}], 0.010)
                const error = measure(sampleRate, signal).truePeak + 6.0
                expect(error).toBeLessThanOrEqual(0.2)
                expect(error).toBeGreaterThanOrEqual(-0.4)
            })
    })

    describe("ITU-R BS.1770 pre-filter", () => {
        const kWeightingDb = (hz: number): number => {
            const w = 2.0 * Math.PI * hz / sampleRate
            const magnitude = (b: ReadonlyArray<number>, a: ReadonlyArray<number>): number =>
                Math.hypot(b[0] + b[1] * Math.cos(w) + b[2] * Math.cos(2.0 * w), b[1] * Math.sin(w) + b[2] * Math.sin(2.0 * w))
                / Math.hypot(a[0] + a[1] * Math.cos(w) + a[2] * Math.cos(2.0 * w), a[1] * Math.sin(w) + a[2] * Math.sin(2.0 * w))
            const shelfK = Math.tan(Math.PI * 1681.974450955533 / sampleRate)
            const shelfQ = 0.7071752369554196
            const vh = Math.pow(10.0, 3.999843853973347 / 20.0)
            const vb = Math.pow(vh, 0.4996667741545416)
            const shelfA0 = 1.0 + shelfK / shelfQ + shelfK * shelfK
            const hpK = Math.tan(Math.PI * 38.13547087602444 / sampleRate)
            const hpQ = 0.5003270373238773
            const hpA0 = 1.0 + hpK / hpQ + hpK * hpK
            return 20.0 * Math.log10(
                magnitude(
                    [(vh + vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0, 2.0 * (shelfK * shelfK - vh) / shelfA0,
                        (vh - vb * shelfK / shelfQ + shelfK * shelfK) / shelfA0],
                    [1.0, 2.0 * (shelfK * shelfK - 1.0) / shelfA0, (1.0 - shelfK / shelfQ + shelfK * shelfK) / shelfA0])
                * magnitude([1.0, -2.0, 1.0], [1.0, 2.0 * (hpK * hpK - 1.0) / hpA0, (1.0 - hpK / hpQ + hpK * hpK) / hpA0]))
        }
        it.each([25, 40, 60, 100, 250, 500, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 16000, 20000])(
            "a -20 dBFS tone at %i Hz reads its weighted level within 0.05 LU", hz => {
                const reading = measure(sampleRate, synthesize(sampleRate, [{db: -20.0, seconds: 6.0, hz}]))
                expect(Math.abs(reading.shortTermMax - (-20.0 - 0.691 + kWeightingDb(hz)))).toBeLessThanOrEqual(0.05)
            })
    })
})

describe("the pre-filter reference used above", () => {
    it("is the filter ITU-R BS.1770 prints for 48 kHz: +0.691 dB at 997 Hz", () => {
        // BS.1770: a 0 dBFS 997 Hz sine on one channel reads -3.01 LKFS
        const meter = new LoudnessMeter(48000)
        const values = new Float32Array(5)
        const signal = synthesize(48000, [{db: 0.0, seconds: 6.0, hz: 997.0}])
        const silence = new Float32Array(QUANTUM)
        for (let i = 0; i + QUANTUM <= signal.length; i += QUANTUM) {
            meter.process(signal.subarray(i, i + QUANTUM), silence)
        }
        meter.fill(values)
        expect(values[1]).toBeCloseTo(-3.01, 2)
    })
})
