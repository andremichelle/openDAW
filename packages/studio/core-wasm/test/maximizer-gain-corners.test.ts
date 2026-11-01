// [Waves] Orange crackle: a clean low-frequency signal came out of the Maximizer with tiny ticks, because the gain
// followed a straight attack ramp with hard corners, restarted by each new peak. The peak meters cannot show them.
// A fourth difference is close to zero for a smooth low tone and spikes on a slope corner.
import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {MaximizerDeviceBox} from "@opendaw/studio-boxes"
import {allFinite, buildEffectProject, leftChannel, peakOf, renderEffect} from "./helpers/effect-harness"

// A 60 Hz sine whose level swells at 3 Hz: the peak hold expires between cycles and new peaks restart the attack.
const SWELLING_TONE = `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, frame: 0}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const time = voice.frame++ / sampleRate
                const level = 0.1 * (1.0 + 0.5 * Math.sin(2.0 * Math.PI * 3.0 * time))
                const s = Math.sin(2.0 * Math.PI * 60.0 * time) * level
                l[i] += s; r[i] += s
            }
        }
    }
}`

const fourthDifferencePeak = (signal: Float32Array, from: number): number => {
    let peak = 0.0
    for (let i = Math.max(4, from); i < signal.length; i++) {
        const value = signal[i] - 4.0 * signal[i - 1] + 6.0 * signal[i - 2] - 4.0 * signal[i - 3] + signal[i - 4]
        peak = Math.max(peak, Math.abs(value))
    }
    return peak
}

const render = (lookahead: boolean, threshold: number): Promise<Float32Array> => renderEffect(
    buildEffectProject(0.0, (source, unit) => MaximizerDeviceBox.create(source, UUID.generate(), box => {
        box.host.refer(unit.audioEffects)
        box.index.setValue(0)
        box.threshold.setValue(threshold)
        box.lookahead.setValue(lookahead)
    }), SWELLING_TONE), 750)

const toneOf = (expression: string): string => `class Processor {
    voices = []
    noteOn(pitch, velocity, cent, id) { this.voices.push({id, frame: 0}) }
    noteOff(id) { this.voices = this.voices.filter(v => v.id !== id) }
    process(output, block) {
        const [l, r] = output
        for (const voice of this.voices) {
            for (let i = block.s0; i < block.s1; i++) {
                const t = voice.frame++ / sampleRate
                const s = ${expression}
                l[i] += s; r[i] += s
            }
        }
    }
}`

// A repeated peak of equal or lower height did not restart the hold, so it expired with that peak still in the
// look-ahead: the gain rose as the peak came out and the hard clamp cut it, a tick at both ends of the flat top.
describe("maximizer holds every peak in the look-ahead", () => {
    const expressions = [
        ...[50, 90, 100, 101, 110, 150, 200, 230, 240].map(frequency => `Math.sin(2 * Math.PI * ${frequency} * t) * 0.2`),
        "Math.sin(2 * Math.PI * 110 * t) * 0.3 * Math.exp(-t * 0.2)",
        "(Math.sin(2 * Math.PI * 100 * t) + Math.sin(2 * Math.PI * 103 * t)) * 0.15"]
    it.each(expressions)("%s is not clamped", async expression => {
        const left = leftChannel(await renderEffect(buildEffectProject(0.0, (source, unit) =>
            MaximizerDeviceBox.create(source, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.index.setValue(0)
                box.threshold.setValue(-24.0)
                box.lookahead.setValue(true)
            }), toneOf(expression)), 750))
        const clamped = left.subarray(9600).reduce((count, sample) => Math.abs(sample) >= 1.0 ? count + 1 : count, 0)
        expect(clamped).toBe(0)
        expect(fourthDifferencePeak(left, 9600)).toBeLessThan(1e-3)
    }, 30000)
})

describe("maximizer gain corners", () => {
    it.each([[true, -24.0], [true, -12.0], [false, -24.0]])("stays smooth, lookahead %s, threshold %s dB", async (lookahead, threshold) => {
        const out = await render(lookahead, threshold)
        const left = leftChannel(out)
        console.log(`lookahead ${lookahead}, threshold ${threshold}: 4th difference ${fourthDifferencePeak(left, 9600)}, peak ${peakOf(left)}`)
        expect(allFinite(out)).toBe(true)
        expect(fourthDifferencePeak(left, 9600)).toBeLessThan(1e-3)
    }, 30000)

    it("still holds a loud signal below 0 dBFS with lookahead", async () => {
        const left = leftChannel(await render(true, -24.0))
        expect(peakOf(left)).toBeGreaterThan(0.9)
        expect(peakOf(left)).toBeLessThanOrEqual(1.0)
    }, 30000)
})
