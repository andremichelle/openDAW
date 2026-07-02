// Verifies `simplifySoundfont` resolves SF2 generators EXACTLY like the TS `SoundfontVoice`: key/velocity range
// intersection of preset × instrument zones, instrument-overrides-preset precedence, timecent→seconds envelope
// conversion, sustain 1−x/1000, root-key override with sample fallback, loop mode from sampleModes, pan ÷1000.
// It decodes the produced blob (the same layout blob.rs reads) and asserts the flattened region + sample.
import {describe, expect, it} from "vitest"
import type {SoundFont2} from "soundfont2"
import {simplifySoundfont} from "../src/soundfont-simplify"

const gen = (value: number) => ({value})
const range = (lo: number, hi: number) => ({range: {lo, hi}})

// A synthetic parsed-SF2 shape (only the fields the walker reads). One preset zone (key 36..72, pan 250) whose
// instrument zone (key 48..84) sets attack/sustain/sampleModes/rootKey and OVERRIDES pan.
const syntheticSoundfont = (): SoundFont2 => {
    const sample = {
        data: Int16Array.from([0, 16384, -16384, 32767, -32768, 0, 100, 200]),
        header: {sampleRate: 44100, startLoop: 10, endLoop: 90, originalPitch: 48}
    }
    return {
        samples: [sample],
        presets: [{
            zones: [{
                generators: {43: range(36, 72), 44: range(0, 127), 17: gen(250)},
                instrument: {
                    zones: [{
                        generators: {
                            43: range(48, 84), // -> intersection 48..72
                            34: gen(1200),      // attack 1200 timecents -> 2^(1200/1200) = 2.0 s
                            37: gen(100),       // sustain 100 -> 1 - 100/1000 = 0.9
                            54: gen(1),         // sampleModes 1 -> loop
                            58: gen(50),        // overriding root key 50
                            17: gen(500)        // pan overrides the preset's 250 -> 500/1000 = 0.5
                        },
                        sample
                    }]
                }
            }]
        }]
    } as unknown as SoundFont2
}

// Minimal decoder over the blob (mirrors blob.rs offsets).
const decode = (buffer: ArrayBuffer) => {
    const view = new DataView(buffer)
    const samplesOff = view.getUint32(20, true), regionsOff = view.getUint32(24, true), presetsOff = view.getUint32(28, true)
    const sample = (i: number) => {
        const b = samplesOff + i * 24
        return {pcmOff: view.getUint32(b, true), frameCount: view.getUint32(b + 4, true), sampleRate: view.getFloat32(b + 8, true), loopStart: view.getUint32(b + 12, true), loopEnd: view.getUint32(b + 16, true)}
    }
    const region = (i: number) => {
        const b = regionsOff + i * 40
        return {
            keyLo: view.getUint8(b), keyHi: view.getUint8(b + 1), velLo: view.getUint8(b + 2), velHi: view.getUint8(b + 3),
            sampleIndex: view.getUint32(b + 4, true), rootKey: view.getUint32(b + 8, true), loopMode: view.getUint32(b + 12, true),
            pan: view.getFloat32(b + 16, true), attack: view.getFloat32(b + 20, true), decay: view.getFloat32(b + 24, true),
            sustain: view.getFloat32(b + 28, true), release: view.getFloat32(b + 32, true)
        }
    }
    return {
        magic: view.getUint32(0, true), sampleCount: view.getUint32(8, true), regionCount: view.getUint32(12, true),
        presetCount: view.getUint32(16, true),
        preset: (i: number) => ({start: view.getUint32(presetsOff + i * 8, true), count: view.getUint32(presetsOff + i * 8 + 4, true)}),
        region, sample,
        pcm: (s: {pcmOff: number, frameCount: number}) => new Float32Array(buffer, s.pcmOff, s.frameCount)
    }
}

describe("soundfont simplify", () => {
    it("flattens preset × instrument zones with TS generator resolution", () => {
        const blob = decode(simplifySoundfont(syntheticSoundfont()))
        expect(blob.magic).toBe(0x4F53_4632)
        expect([blob.sampleCount, blob.regionCount, blob.presetCount]).toEqual([1, 1, 1])
        expect(blob.preset(0)).toEqual({start: 0, count: 1})
        const region = blob.region(0)
        expect([region.keyLo, region.keyHi]).toEqual([48, 72]) // intersection of preset 36..72 and inst 48..84
        expect([region.velLo, region.velHi]).toEqual([0, 127])
        expect(region.rootKey).toBe(50) // OverridingRootKey wins over the sample's originalPitch 48
        expect(region.loopMode).toBe(1) // sampleModes 1
        expect(region.pan).toBeCloseTo(0.5, 6) // instrument's 500 overrides the preset's 250, /1000
        expect(region.attack).toBeCloseTo(2.0, 6) // 2^(1200/1200)
        expect(region.decay).toBeCloseTo(0.005, 6) // absent -> default
        expect(region.sustain).toBeCloseTo(0.9, 6) // 1 - 100/1000
        expect(region.release).toBeCloseTo(0.005, 6) // absent -> default
    })

    it("copies the sample header + normalizes Int16 PCM to f32", () => {
        const blob = decode(simplifySoundfont(syntheticSoundfont()))
        const sample = blob.sample(0)
        expect(sample.sampleRate).toBe(44100)
        expect([sample.loopStart, sample.loopEnd]).toEqual([10, 90])
        expect(sample.frameCount).toBe(8)
        const pcm = blob.pcm(sample)
        expect(pcm[1]).toBeCloseTo(16384 / 32768, 5) // 0.5
        expect(pcm[3]).toBeCloseTo(32767 / 32768, 5) // ~1.0
        expect(pcm[4]).toBeCloseTo(-32768 / 32768, 5) // -1.0
    })
})
