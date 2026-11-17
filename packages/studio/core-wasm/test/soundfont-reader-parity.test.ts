// The move from the soundfont2 package to spessasynth_core must not change a single byte of what the engine gets:
// every soundfont is read by both, the simplified blob and the preset list must be identical.
// Real files: set OPENDAW_SOUNDFONT_DIR to a folder of .sf2 files (the catalog soundfonts), synthetic ones always run.
import {describe, expect, it} from "vitest"
import {existsSync, readdirSync, readFileSync} from "node:fs"
import {SoundFont2} from "soundfont2"
import {SoundBankLoader} from "spessasynth_core"
import {SamplerImport, SamplerSoundfont, SamplerSoundfontExport, SoundfontBank} from "@opendaw/studio-adapters"
import {simplifySoundfont} from "../src/soundfont-simplify"

const readNew = (bytes: Uint8Array): SoundfontBank.Bank => {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    return SoundfontBank.from(SoundBankLoader.fromArrayBuffer(buffer), buffer)
}
const readOld = (bytes: Uint8Array): SoundfontBank.Bank => new SoundFont2(bytes) as unknown as SoundfontBank.Bank
const presetList = (bank: SoundfontBank.Bank) => bank.presets.map(({header: {name, bank, preset}}) => `${bank}:${preset} ${name}`)
const expectParity = (bytes: Uint8Array) => {
    const before = readOld(bytes), after = readNew(bytes)
    expect(presetList(after)).toEqual(presetList(before))
    const expected = new Uint8Array(simplifySoundfont(before)), actual = new Uint8Array(simplifySoundfont(after))
    expect(actual.length).toBe(expected.length)
    expect(actual.findIndex((value, index) => value !== expected[index])).toBe(-1)
    before.presets.forEach((_, index) => {
        const old = SamplerSoundfont.convert(before, index), now = SamplerSoundfont.convert(after, index)
        expect(JSON.stringify(now.instrument)).toBe(JSON.stringify(old.instrument))
        expect(now.samples.map(({name, sampleRate, channels}) => [name, sampleRate, channels.map(channel => channel.length)]))
            .toEqual(old.samples.map(({name, sampleRate, channels}) => [name, sampleRate, channels.map(channel => channel.length)]))
        now.samples.forEach((sample, sampleIndex) => sample.channels.forEach((channel, channelIndex) =>
            expect(channel === old.samples[sampleIndex].channels[channelIndex]
                || channel.every((value, frame) => value === old.samples[sampleIndex].channels[channelIndex][frame])).toBe(true)))
    })
}

const zone = (overrides: Partial<SamplerImport.Zone>): SamplerImport.Zone => ({
    sample: 0, group: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootKey: 60, transpose: 0, tune: 0,
    keyTrack: 1, gain: 0, panning: 0, sequence: 1, reverse: false, oneShot: false, sampleStart: 0, sampleEnd: undefined,
    loopMode: 0, loopStart: 0, loopEnd: undefined, loopAlternate: false, ...overrides
})
const noise = (length: number, seed: number): Int16Array =>
    Int16Array.from({length}, (_, index) => ((index * 7919 + seed * 104729) % 65536) - 32768)
const synthetic = (): Uint8Array => new Uint8Array(SamplerSoundfontExport.encode({
    name: "Parity", groups: [{label: "Group 1", roundRobin: 0, choke: 0, trigger: 0}], envelope: undefined, filter: undefined,
    zones: [
        zone({keyLow: 36, keyHigh: 59, velocityLow: 1, velocityHigh: 90, rootKey: 48, transpose: -2, tune: 17, panning: -0.5,
            loopMode: 2, loopStart: 100, loopEnd: 900}),
        zone({sample: 1, keyLow: 60, keyHigh: 96, rootKey: 72, tune: -33, gain: -6, panning: 0.25}),
        zone({sample: 2, keyLow: 60, keyHigh: 96, velocityLow: 91, velocityHigh: 127, rootKey: 72, loopMode: 1})
    ]
}, [
    {name: "Low", sampleRate: 44100, channels: [noise(1000, 1)]},
    {name: "High", sampleRate: 48000, channels: [noise(700, 2), noise(700, 3)]},
    {name: "Hard", sampleRate: 22050, channels: [noise(333, 4)]}
]))

// the INAM sub-chunk's text, kept at its size
const emptyName = (bytes: Uint8Array): Uint8Array => {
    const copy = bytes.slice()
    for (let index = 0; index + 8 < copy.length; index++) {
        if (copy[index] === 0x49 && copy[index + 1] === 0x4E && copy[index + 2] === 0x41 && copy[index + 3] === 0x4D) {
            const size = new DataView(copy.buffer).getUint32(index + 4, true)
            copy.fill(0, index + 8, index + 8 + size)
            return copy
        }
    }
    throw new Error("no INAM")
}

describe("soundfont reader parity", () => {
    it("reads a synthetic soundfont into the same blob as before", () => expectParity(synthetic()))
    it("reads a soundfont with an empty name, which the old reader refused (issue 464)", () => {
        const bytes = emptyName(synthetic())
        expect(() => readOld(bytes)).toThrow()
        const bank = readNew(bytes)
        expect(bank.metaData.name).toBe("")
        expect(presetList(bank)).toEqual(["0:0 Parity"])
        expect(simplifySoundfont(bank).byteLength).toBeGreaterThan(0)
    })
    const folder = process.env.OPENDAW_SOUNDFONT_DIR
    const files = folder !== undefined && existsSync(folder)
        ? readdirSync(folder).filter(name => name.toLowerCase().endsWith(".sf2")) : []
    it.skipIf(files.length === 0).each(files)("reads %s into the same blob as before", name => {
        const bytes = new Uint8Array(readFileSync(`${folder}/${name}`))
        let readable = true
        try {readOld(bytes)} catch {readable = false}
        if (readable) {expectParity(bytes)} else {expect(readNew(bytes).presets.length).toBeGreaterThan(0)}
    }, 120_000)
})
