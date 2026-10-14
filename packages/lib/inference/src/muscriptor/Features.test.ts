import {describe, expect, it} from "vitest"
import {CHUNK_SAMPLES, muScriptorLogMel, prepareMuScriptorAudio} from "./Features"

describe("MuScriptor audio preparation", () => {
    it("downmixes and crops the chosen file range", () => {
        const channels = [new Float32Array(32000).fill(0.2), new Float32Array(32000).fill(0.6)]
        const audio = prepareMuScriptorAudio({channels, sampleRate: 16000, start: 0.5, end: 1})
        expect(audio.length).toBe(8000)
        expect(audio[0]).toBeCloseTo(0.4)
    })
    it("rejects invalid audio before allocating the model input", () => {
        expect(() => prepareMuScriptorAudio({channels: [], sampleRate: 16000, start: 0, end: 1})).toThrow()
        expect(() => prepareMuScriptorAudio({channels: [Float32Array.of(NaN)], sampleRate: 16000, start: 0, end: 1 / 16000})).toThrow()
    })
    it("suppresses frequencies above the new Nyquist limit", () => {
        const signal = (hz: number): Float32Array => Float32Array.from({length: 4800}, (_, i) => Math.sin(2 * Math.PI * hz * i / 48000))
        const convert = (hz: number): Float32Array => prepareMuScriptorAudio({channels: [signal(hz)], sampleRate: 48000, start: 0, end: 0.1})
        const rms = (a: Float32Array): number => Math.sqrt(a.subarray(100, -100).reduce((sum, v) => sum + v * v, 0) / (a.length - 200))
        expect(rms(convert(440))).toBeGreaterThan(0.65)
        expect(rms(convert(12000))).toBeLessThan(0.002)
    })
    it("matches the silence floor and centered 501-frame model shape", () => {
        const result = muScriptorLogMel(new Float32Array(CHUNK_SAMPLES))
        expect(result.frames).toBe(501)
        expect(result.data.length).toBe(501 * 512)
        expect(result.data.every(value => Math.abs(value - Math.log(1e-6)) < 1e-5)).toBe(true)
    })
    it("places a 440 Hz tone near the expected HTK mel band", () => {
        const audio = Float32Array.from({length: CHUNK_SAMPLES}, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / 16000))
        const {data} = muScriptorLogMel(audio)
        const middle = data.subarray(250 * 512, 251 * 512)
        const peak = middle.indexOf(Math.max(...middle))
        expect(peak).toBeGreaterThan(95)
        expect(peak).toBeLessThan(102)
        // Independent NumPy rFFT reference, using float32 PCM and window samples.
        const reference = [0.9757166, 2.7728781, 3.3292249, 4.3823975, 4.0617710,
            3.0296637, 1.7092528, 0.4947613, -0.9512596]
        reference.forEach((value, i) => expect(middle[95 + i]).toBeCloseTo(value, 3))
    })
})
