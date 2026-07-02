// Builds the SIMPLIFIED soundfont BLOB the wasm engine consumes (see crates/stock-devices/device-soundfont/
// src/blob.rs — the format is a WASM CONTRACT mirrored on both sides). The main thread keeps the parsed SF2;
// this flattens it into a compact, directly-indexable structure so the wasm never parses SF2/RIFF.
//
// `encodeSoundfont` serializes a plain description (samples + per-preset regions) into the blob. `simplify-
// Soundfont` walks a parsed `SoundFont2` into that description, resolving every SF2 generator EXACTLY as the TS
// `SoundfontVoice` does: preset-zone × instrument-zone flattening, instrument-overrides-preset precedence,
// timecent→seconds envelope conversion, sustain 1−x/1000, root-key/loop/pan resolution.

import type {SoundFont2} from "soundfont2"

// SF2 generator IDs (spec-fixed), the only ones the TS `SoundfontVoice` honors. Inlined to avoid a brittle
// cross-package deep import; they are a frozen contract.
const GeneratorType = {
    Pan: 17,
    AttackVolEnv: 34,
    DecayVolEnv: 36,
    SustainVolEnv: 37,
    ReleaseVolEnv: 38,
    KeyRange: 43,
    VelRange: 44,
    CoarseTune: 51,
    FineTune: 52,
    SampleId: 53,
    SampleModes: 54,
    OverridingRootKey: 58
} as const

// ---- The simplified description (pre-serialization) --------------------------------------------------------

export type SimpleSample = {
    pcm: Float32Array   // already normalized (Int16 / 32768)
    sampleRate: number
    loopStart: number   // relative to the sample start (as the SF2 parser makes them)
    loopEnd: number
}

export type SimpleRegion = {
    keyLo: number, keyHi: number, velLo: number, velHi: number
    sampleIndex: number
    rootKey: number
    loopMode: number    // 0 = no loop, 1 = loop
    pan: number         // already /1000
    attack: number, decay: number, sustain: number, release: number // seconds / unit level (already converted)
}

export type SimpleSoundfont = {
    samples: ReadonlyArray<SimpleSample>
    presets: ReadonlyArray<ReadonlyArray<SimpleRegion>> // regions per preset (index = presetIndex)
}

// ---- Binary layout (mirrors blob.rs) -----------------------------------------------------------------------

const MAGIC = 0x4F53_4632 // "OSF2"
const HEADER_BYTES = 32
const SAMPLE_STRIDE = 24
const REGION_STRIDE = 40
const PRESET_STRIDE = 8

export const encodeSoundfont = ({samples, presets}: SimpleSoundfont): ArrayBuffer => {
    const regionCount = presets.reduce((sum, regions) => sum + regions.length, 0)
    const samplesOff = HEADER_BYTES
    const regionsOff = samplesOff + samples.length * SAMPLE_STRIDE
    const presetsOff = regionsOff + regionCount * REGION_STRIDE
    const pcmOff = presetsOff + presets.length * PRESET_STRIDE
    const pcmFrames = samples.reduce((sum, sample) => sum + sample.pcm.length, 0)
    const buffer = new ArrayBuffer(pcmOff + pcmFrames * 4)
    const view = new DataView(buffer)
    view.setUint32(0, MAGIC, true)
    view.setUint32(4, 1, true) // version
    view.setUint32(8, samples.length, true)
    view.setUint32(12, regionCount, true)
    view.setUint32(16, presets.length, true)
    view.setUint32(20, samplesOff, true)
    view.setUint32(24, regionsOff, true)
    view.setUint32(28, presetsOff, true)
    // Sample table + PCM (concatenated planes).
    let pcmCursor = pcmOff
    samples.forEach((sample, index) => {
        const base = samplesOff + index * SAMPLE_STRIDE
        view.setUint32(base, pcmCursor, true)
        view.setUint32(base + 4, sample.pcm.length, true)
        view.setFloat32(base + 8, sample.sampleRate, true)
        view.setUint32(base + 12, sample.loopStart, true)
        view.setUint32(base + 16, sample.loopEnd, true)
        new Float32Array(buffer, pcmCursor, sample.pcm.length).set(sample.pcm)
        pcmCursor += sample.pcm.length * 4
    })
    // Region table (all presets flattened) + preset table (each preset's [start, count) range).
    let regionCursor = 0
    presets.forEach((regions, presetIndex) => {
        const presetBase = presetsOff + presetIndex * PRESET_STRIDE
        view.setUint32(presetBase, regionCursor, true)
        view.setUint32(presetBase + 4, regions.length, true)
        for (const region of regions) {
            const base = regionsOff + regionCursor * REGION_STRIDE
            view.setUint8(base, region.keyLo)
            view.setUint8(base + 1, region.keyHi)
            view.setUint8(base + 2, region.velLo)
            view.setUint8(base + 3, region.velHi)
            view.setUint32(base + 4, region.sampleIndex, true)
            view.setUint32(base + 8, region.rootKey, true)
            view.setUint32(base + 12, region.loopMode, true)
            view.setFloat32(base + 16, region.pan, true)
            view.setFloat32(base + 20, region.attack, true)
            view.setFloat32(base + 24, region.decay, true)
            view.setFloat32(base + 28, region.sustain, true)
            view.setFloat32(base + 32, region.release, true)
            regionCursor++
        }
    })
    return buffer
}

// ---- SF2 → simplified description (mirrors SoundfontVoice's generator resolution) --------------------------

type Zone = {generators: Record<number, {value?: number, range?: {lo: number, hi: number}}>}

const numeric = (zone: Zone, type: number): number | undefined => zone.generators[type]?.value
// instrument-overrides-preset, matching TS `getCombinedGenerator`.
const combined = (preset: Zone, inst: Zone, type: number): number | undefined => numeric(inst, type) ?? numeric(preset, type)
const timecentsToSeconds = (value: number | undefined): number => value !== undefined ? Math.pow(2.0, value / 1200.0) : 0.005
const rangeOf = (zone: Zone, type: number): {lo: number, hi: number} => zone.generators[type]?.range ?? {lo: 0, hi: 127}

export const simplifySoundfont = (soundfont: SoundFont2): ArrayBuffer => {
    const samples: SimpleSample[] = []
    const sampleIndexByRef = new Map<object, number>()
    const internSample = (sample: {data: Int16Array, header: {sampleRate: number, startLoop: number, endLoop: number}}): number => {
        const existing = sampleIndexByRef.get(sample)
        if (existing !== undefined) {return existing}
        const pcm = new Float32Array(sample.data.length)
        for (let i = 0; i < pcm.length; i++) {pcm[i] = sample.data[i] / 32768.0}
        const index = samples.length
        samples.push({pcm, sampleRate: sample.header.sampleRate, loopStart: sample.header.startLoop, loopEnd: sample.header.endLoop})
        sampleIndexByRef.set(sample, index)
        return index
    }
    const presets: SimpleRegion[][] = soundfont.presets.map(preset => {
        const regions: SimpleRegion[] = []
        for (const presetZone of preset.zones as ReadonlyArray<Zone & {instrument: {zones: ReadonlyArray<Zone & {sample: any}>}}>) {
            const presetKey = rangeOf(presetZone, GeneratorType.KeyRange)
            const presetVel = rangeOf(presetZone, GeneratorType.VelRange)
            for (const instZone of presetZone.instrument.zones) {
                const instKey = rangeOf(instZone, GeneratorType.KeyRange)
                const instVel = rangeOf(instZone, GeneratorType.VelRange)
                // A note matches iff it is inside BOTH zones' ranges (TS tests each independently) = the intersection.
                const keyLo = Math.max(presetKey.lo, instKey.lo), keyHi = Math.min(presetKey.hi, instKey.hi)
                const velLo = Math.max(presetVel.lo, instVel.lo), velHi = Math.min(presetVel.hi, instVel.hi)
                if (keyLo > keyHi || velLo > velHi) {continue} // empty intersection: unreachable, drop it
                const sample = instZone.sample ?? soundfont.samples[numeric(instZone, GeneratorType.SampleId) ?? 0]
                if (sample === undefined) {continue}
                const sampleIndex = internSample(sample)
                const rootKey = numeric(instZone, GeneratorType.OverridingRootKey) ?? sample.header.originalPitch ?? 60
                const sampleModes = combined(presetZone, instZone, GeneratorType.SampleModes) ?? 0
                const sustain = combined(presetZone, instZone, GeneratorType.SustainVolEnv)
                regions.push({
                    keyLo, keyHi, velLo, velHi, sampleIndex, rootKey,
                    loopMode: sampleModes === 1 || sampleModes === 3 ? 1 : 0,
                    pan: (combined(presetZone, instZone, GeneratorType.Pan) ?? 0) / 1000.0,
                    attack: timecentsToSeconds(combined(presetZone, instZone, GeneratorType.AttackVolEnv)),
                    decay: timecentsToSeconds(combined(presetZone, instZone, GeneratorType.DecayVolEnv)),
                    sustain: 1.0 - (sustain ?? 0.0) / 1000.0,
                    release: timecentsToSeconds(combined(presetZone, instZone, GeneratorType.ReleaseVolEnv))
                })
            }
        }
        return regions
    })
    return encodeSoundfont({samples, presets})
}
