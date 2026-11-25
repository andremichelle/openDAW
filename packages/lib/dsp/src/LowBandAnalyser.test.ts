import {describe, expect, test} from "vitest"
import {AudioAnalyser} from "./AudioAnalyser"
import {LowBandAnalyser} from "./LowBandAnalyser"
import {gainToDb} from "./utils"

const BLOCK = 128

const feed = (analyser: { process(left: Float32Array, right: Float32Array, from: number, to: number): void },
              sampleRate: number, frames: number, signal: (seconds: number) => number, start: number = 0): void => {
    const block = new Float32Array(BLOCK)
    for (let offset = 0; offset < frames; offset += BLOCK) {
        for (let index = 0; index < BLOCK; index++) {block[index] = signal((start + offset + index) / sampleRate)}
        analyser.process(block, block, 0, BLOCK)
    }
}

const sine = (frequency: number, gain: number = 0.25) =>
    (seconds: number): number => Math.sin(2.0 * Math.PI * frequency * seconds) * gain

const peakBin = (bins: Float32Array): number => bins.reduce((best, value, index) => value > bins[best] ? index : best, 0)

const settle = (sampleRate: number): number => 1 << 15 << Math.round(Math.log2(sampleRate / 48000))

describe("LowBandAnalyser", () => {
    test.each([44100, 48000, 96000])("keeps about 6 Hz bins at %i Hz", sampleRate => {
        const width = LowBandAnalyser.binWidth(sampleRate)
        expect(width).toBeGreaterThan(5.0)
        expect(width).toBeLessThan(6.5)
        expect(width * LowBandAnalyser.NUM_BINS).toBeGreaterThan(LowBandAnalyser.CROSSOVER)
    })
    test.each([44100, 48000, 96000])("a 60 Hz sine peaks in its own bin at %i Hz", sampleRate => {
        const analyser = new LowBandAnalyser(sampleRate)
        feed(analyser, sampleRate, settle(sampleRate), sine(60.0))
        expect(peakBin(analyser.bins())).toBe(Math.round(60.0 / LowBandAnalyser.binWidth(sampleRate)))
    })
    test("separates 50 Hz from 80 Hz", () => {
        const analyser = new LowBandAnalyser(48000)
        feed(analyser, 48000, settle(48000), seconds => sine(50.0)(seconds) + sine(80.0)(seconds))
        const bins = analyser.bins()
        const width = LowBandAnalyser.binWidth(48000)
        const middle = bins[Math.round(65.0 / width)]
        expect(gainToDb(bins[Math.round(50.0 / width)]) - gainToDb(middle)).toBeGreaterThan(6.0)
        expect(gainToDb(bins[Math.round(80.0 / width)]) - gainToDb(middle)).toBeGreaterThan(6.0)
    })
    test("reads a steady tone at the same level as the main analyser", () => {
        const low = new LowBandAnalyser(48000)
        const main = new AudioAnalyser()
        const frames = settle(48000)
        // bin 4 of the main analyser and bin 32 of the low band are both exactly 187.5 Hz
        feed(low, 48000, frames, sine(187.5))
        feed(main, 48000, frames, sine(187.5))
        expect(gainToDb(low.bins()[32]) - gainToDb(main.bins()[4])).toBeCloseTo(0.0, 0)
    })
    test.each([5750.0, 5800.0, 5950.0, 6050.0, 6250.0, 11900.0, 12100.0, 18100.0])(
        "%f Hz does not fold into the displayed range", frequency => {
            const analyser = new LowBandAnalyser(48000)
            // arm the decay like the live consumer does, so only the sustained alias remains, not the onset click
            for (let hop = 0; hop < 256; hop++) {
                feed(analyser, 48000, 1024, sine(frequency, 1.0), hop * 1024)
                analyser.decay = true
            }
            const displayed = Math.ceil(LowBandAnalyser.CROSSOVER / LowBandAnalyser.binWidth(48000))
            const loudest = analyser.bins().subarray(0, displayed).reduce((max, value) => Math.max(max, value), 0.0)
            expect(gainToDb(loudest)).toBeLessThan(-80.0)
        })
    test("updates every 1024 input samples, as the main analyser does", () => {
        const analyser = new LowBandAnalyser(48000)
        feed(analyser, 48000, 896, sine(60.0))
        expect(analyser.bins().every(value => value === 0.0)).toBe(true)
        feed(analyser, 48000, 128, sine(60.0), 896)
        expect(analyser.bins().some(value => value > 0.0)).toBe(true)
    })
    test("holds until the consumer arms the decay, then fades", () => {
        const analyser = new LowBandAnalyser(48000)
        feed(analyser, 48000, settle(48000), sine(60.0))
        const bin = peakBin(analyser.bins())
        const held = analyser.bins()[bin]
        const silence = () => 0.0
        feed(analyser, 48000, 1 << 14, silence)
        expect(analyser.bins()[bin]).toBe(held)
        analyser.decay = true
        feed(analyser, 48000, 1 << 11, silence)
        expect(analyser.bins()[bin]).toBeLessThan(held)
    })
    test("clear drops bins and filter state", () => {
        const analyser = new LowBandAnalyser(48000)
        feed(analyser, 48000, settle(48000), sine(60.0))
        analyser.clear()
        expect(analyser.bins().every(value => value === 0.0)).toBe(true)
        feed(analyser, 48000, 1 << 14, () => 0.0)
        expect(analyser.bins().every(value => value === 0.0)).toBe(true)
    })
})
