import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, SamplerDeviceBox} from "@opendaw/studio-boxes"
import {SoundFont2} from "soundfont2"
import {ProjectSkeleton} from "../../../project/ProjectSkeleton"
import {SamplerImport} from "./SamplerImport"
import {SamplerSoundfont} from "./SamplerSoundfont"
import {SamplerSoundfontExport} from "./SamplerSoundfontExport"
import {SamplerZones} from "./SamplerZones"

const zone = (overrides: Partial<SamplerImport.Zone> = {}): SamplerImport.Zone => ({
    sample: 0, group: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootKey: 60, transpose: 0, tune: 0,
    keyTrack: 1, gain: 0, panning: 0, sequence: 1, reverse: false, oneShot: false, sampleStart: 0, sampleEnd: undefined,
    loopMode: 0, loopStart: 0, loopEnd: undefined, loopAlternate: false, ...overrides
})
const ramp = (length: number, offset: number = 0): Int16Array => Int16Array.from({length}, (_, index) => index + offset)
const group: SamplerImport.Group = {label: "Group 1", roundRobin: 0, choke: 0, trigger: 0}
const roundTrip = (instrument: SamplerImport.Instrument, samples: ReadonlyArray<SamplerImport.Sample>) =>
    SamplerSoundfont.convert(new SoundFont2(new Uint8Array(SamplerSoundfontExport.encode(instrument, samples))), 0)

describe("SamplerSoundfontExport.encode", () => {
    it("writes a soundfont the reader accepts, with one preset named after the instrument", () => {
        const soundfont = new SoundFont2(new Uint8Array(SamplerSoundfontExport.encode(
            {name: "Upright", groups: [group], zones: [zone()], envelope: undefined, filter: undefined},
            [{name: "C4", sampleRate: 48000, channels: [ramp(500)]}])))
        expect(soundfont.presets).toHaveLength(1)
        expect(soundfont.presets[0].header.name).toBe("Upright")
        expect(SamplerSoundfont.presetNames(soundfont)).toEqual(["000:000 Upright"])
    })
    it("keeps the frames, the name and the sample rate of a sample", () => {
        const {samples} = roundTrip({name: "A", groups: [group], zones: [zone()], envelope: undefined, filter: undefined},
            [{name: "C4", sampleRate: 48000, channels: [ramp(500, -200)]}])
        expect(samples).toHaveLength(1)
        expect(samples[0].name).toBe("C4")
        expect(samples[0].sampleRate).toBe(48000)
        expect(Array.from(samples[0].channels[0])).toEqual(Array.from(ramp(500, -200)))
    })
    it("round trips ranges, root, tuning, gain, pan, offsets and loop of a zone", () => {
        const source = zone({
            keyLow: 48, keyHigh: 59, velocityLow: 10, velocityHigh: 90, rootKey: 52, transpose: -3, tune: 25, keyTrack: 0.5,
            gain: -4, panning: -0.5, sampleStart: 20, sampleEnd: 970, loopMode: 2, loopStart: 100, loopEnd: 900
        })
        const {instrument} = roundTrip({name: "A", groups: [group], zones: [source], envelope: undefined, filter: undefined},
            [{name: "s", sampleRate: 44100, channels: [ramp(1000)]}])
        expect(instrument.zones).toHaveLength(1)
        const {gain, ...rest} = instrument.zones[0]
        const {gain: _gain, ...expected} = source
        expect(rest).toEqual(expected)
        expect(gain).toBeCloseTo(-4, 6)
    })
    it("round trips the loop modes", () => {
        const modes = [0, 1, 2].map(loopMode => roundTrip(
            {name: "A", groups: [group], zones: [zone({loopMode})], envelope: undefined, filter: undefined},
            [{name: "s", sampleRate: 44100, channels: [ramp(100)]}]).instrument.zones[0].loopMode)
        expect(modes).toEqual([0, 1, 2])
    })
    it("gives zones that share a sample their own loop and offsets", () => {
        const {instrument, samples} = roundTrip({
            name: "A", groups: [group], envelope: undefined, filter: undefined, zones: [
                zone({keyHigh: 59, loopMode: 2, loopStart: 100, loopEnd: 900}),
                zone({keyLow: 60, loopMode: 2, loopStart: 300, loopEnd: 700, sampleStart: 50})
            ]
        }, [{name: "s", sampleRate: 44100, channels: [ramp(1000)]}])
        expect(samples).toHaveLength(1)
        expect(instrument.zones.map(({loopStart, loopEnd, sampleStart}) => [loopStart, loopEnd, sampleStart]))
            .toEqual([[100, 900, 0], [300, 700, 50]])
    })
    it("writes offsets beyond 32767 frames with the coarse generators", () => {
        const {instrument} = roundTrip({
            name: "A", groups: [group], envelope: undefined, filter: undefined,
            zones: [zone({sampleStart: 70000, sampleEnd: 150000, loopMode: 2, loopStart: 80000, loopEnd: 140000})]
        }, [{name: "s", sampleRate: 44100, channels: [new Int16Array(200000)]}])
        expect(instrument.zones[0]).toMatchObject({sampleStart: 70000, sampleEnd: 150000, loopStart: 80000, loopEnd: 140000})
    })
    it("writes a stereo sample as a linked pair the importer joins again", () => {
        const left = ramp(300), right = ramp(300, 1000)
        const {instrument, samples} = roundTrip(
            {name: "A", groups: [group], zones: [zone({keyLow: 40, keyHigh: 50})], envelope: undefined, filter: undefined},
            [{name: "Grand", sampleRate: 44100, channels: [left, right]}])
        expect(samples).toHaveLength(1)
        expect(samples[0].name).toBe("Grand")
        expect(samples[0].channels.map(channel => Array.from(channel))).toEqual([Array.from(left), Array.from(right)])
        expect(instrument.zones).toHaveLength(1)
        expect(instrument.zones[0]).toMatchObject({keyLow: 40, keyHigh: 50, panning: 0})
    })
    it("turns choke groups into exclusive classes", () => {
        const {instrument} = roundTrip({
            name: "A", envelope: undefined, filter: undefined,
            groups: [group, {label: "Hats", roundRobin: 0, choke: 3, trigger: 0}],
            zones: [zone({keyHigh: 59}), zone({keyLow: 60, group: 1})]
        }, [{name: "s", sampleRate: 44100, channels: [ramp(100)]}])
        expect(instrument.groups.map(({choke}) => choke)).toEqual([0, 3])
        expect(instrument.zones.map(({group}) => group)).toEqual([0, 1])
    })
    it("round trips the envelope and the filter", () => {
        const {instrument} = roundTrip({
            name: "A", groups: [group], zones: [zone()],
            envelope: {delay: 0.0, attack: 0.01, hold: 0.5, decay: 2.0, sustain: 0.5, release: 1.0},
            filter: {cutoff: 1000.0, resonance: 0.25}
        }, [{name: "s", sampleRate: 44100, channels: [ramp(100)]}])
        const {envelope, filter} = instrument
        expect(envelope?.delay).toBe(0.0)
        expect(envelope?.attack).toBeCloseTo(0.01, 4)
        expect(envelope?.hold).toBeCloseTo(0.5, 3)
        expect(envelope?.decay).toBeCloseTo(2.0, 2)
        expect(envelope?.sustain).toBeCloseTo(0.5, 2)
        expect(envelope?.release).toBeCloseTo(1.0, 3)
        expect(filter?.cutoff).toBeCloseTo(1000.0, 0)
        expect(filter?.resonance).toBeCloseTo(0.25, 3)
    })
    it("writes a reversed zone as a reversed copy of its sample with mirrored points", () => {
        const {instrument, samples} = roundTrip({
            name: "A", groups: [group], envelope: undefined, filter: undefined, zones: [
                zone({keyHigh: 59}),
                zone({keyLow: 60, reverse: true, sampleStart: 10, sampleEnd: 90, loopMode: 2, loopStart: 20, loopEnd: 60}),
                zone({keyLow: 60, velocityHigh: 64, reverse: true})
            ]
        }, [{name: "s", sampleRate: 44100, channels: [ramp(100)]}])
        expect(samples.map(({name}) => name)).toEqual(["s", "s rev"])
        expect(Array.from(samples[1].channels[0])).toEqual(Array.from(ramp(100)).reverse())
        expect(instrument.zones.map(({sample, reverse}) => [sample, reverse])).toEqual([[0, false], [1, false], [1, false]])
        expect(instrument.zones[1]).toMatchObject({sampleStart: 10, sampleEnd: 90, loopStart: 40, loopEnd: 80})
        expect(instrument.zones[2]).toMatchObject({sampleStart: 0, sampleEnd: 100})
    })
    it("leaves out a zone whose sample is missing", () => {
        const {instrument, samples} = roundTrip({
            name: "A", groups: [group], envelope: undefined, filter: undefined,
            zones: [zone({keyHigh: 59}), zone({keyLow: 60, sample: 1})]
        }, [undefined as never, {name: "s", sampleRate: 44100, channels: [ramp(100)]}])
        expect(samples).toHaveLength(1)
        expect(instrument.zones).toHaveLength(1)
        expect(instrument.zones[0].keyLow).toBe(60)
    })
    it("writes an instrument without zones", () => {
        const {instrument, samples} = roundTrip({name: "Empty", groups: [], zones: [], envelope: undefined, filter: undefined}, [])
        expect(instrument.name).toBe("Empty")
        expect(instrument.zones).toHaveLength(0)
        expect(samples).toHaveLength(0)
    })
    it("cuts long names to what the format holds", () => {
        const {instrument, samples} = roundTrip(
            {name: "A very long instrument name indeed", groups: [group], zones: [zone()], envelope: undefined, filter: undefined},
            [{name: "A very long sample name indeed", sampleRate: 44100, channels: [ramp(100)]}])
        expect(instrument.name).toBe("A very long instrum")
        expect(samples[0].name).toBe("A very long sample ".trim())
    })
})

describe("SamplerSoundfontExport.quantize", () => {
    it("maps full scale to 16 bit and counts nothing as clipped", () => {
        const {frames, clipped} = SamplerSoundfontExport.quantize(Float32Array.from([0, 0.5, -0.5, -1, 32767 / 32768]))
        expect(Array.from(frames)).toEqual([0, 16384, -16384, -32768, 32767])
        expect(clipped).toBe(0)
    })
    it("clamps and counts frames beyond full scale", () => {
        const {frames, clipped} = SamplerSoundfontExport.quantize(Float32Array.from([1, 1.5, -1.5, 0.25]))
        expect(Array.from(frames)).toEqual([32767, 32767, -32768, 8192])
        expect(clipped).toBe(3)
    })
    it("reads back exactly what a 16 bit import stored", () => {
        const source = Int16Array.from([-32768, -1, 0, 1, 12345, 32767])
        const {frames, clipped} = SamplerSoundfontExport.quantize(Float32Array.from(source, value => value / 32768))
        expect(Array.from(frames)).toEqual(Array.from(source))
        expect(clipped).toBe(0)
    })
})

describe("SamplerSoundfontExport.describe", () => {
    const setup = () => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        boxGraph.beginTransaction()
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
        })
        const device = SamplerDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.input)
            box.label.setValue("Kit")
        })
        const main = SamplerZones.createGroup(boxGraph, device, "Main")
        const file = (name: string): AudioFileBox => AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue(name))
        return {boxGraph, device, main, file}
    }
    it("describes zones in order, shares a file between zones and leaves the ends open", () => {
        const {boxGraph, device, main, file} = setup()
        const kick = file("kick.wav"), snare = file("snare.wav")
        const first = SamplerZones.create(boxGraph, device, main, kick)
        const second = SamplerZones.create(boxGraph, device, main, snare)
        const third = SamplerZones.create(boxGraph, device, main, kick)
        first.keyHigh.setValue(40)
        second.rootKey.setValue(38)
        third.sampleEnd.setValue(500)
        boxGraph.endTransaction()
        const {instrument, files, skipped} = SamplerSoundfontExport.describe(device)
        expect(instrument.name).toBe("Kit")
        expect(files).toEqual([kick, snare])
        expect(instrument.zones.map(({sample}) => sample)).toEqual([0, 1, 0])
        expect(instrument.zones[0].keyHigh).toBe(40)
        expect(instrument.zones[1].rootKey).toBe(38)
        expect(instrument.zones.map(({sampleEnd}) => sampleEnd)).toEqual([undefined, undefined, 500])
        expect(skipped).toBe(0)
    })
    it("skips disabled zones silently, further round robins and release triggers counted", () => {
        const {boxGraph, device, main, file} = setup()
        const release = SamplerZones.createGroup(boxGraph, device, "Release")
        release.trigger.setValue(1)
        main.roundRobin.setValue(1)
        const one = SamplerZones.create(boxGraph, device, main, file("a.wav"))
        const two = SamplerZones.create(boxGraph, device, main, file("b.wav"))
        const off = SamplerZones.create(boxGraph, device, main, file("c.wav"))
        SamplerZones.create(boxGraph, device, release, file("d.wav"))
        one.sequence.setValue(1)
        two.sequence.setValue(2)
        off.enabled.setValue(false)
        boxGraph.endTransaction()
        const {instrument, files, skipped} = SamplerSoundfontExport.describe(device)
        expect(instrument.zones).toHaveLength(1)
        expect(files).toHaveLength(1)
        expect(skipped).toBe(2)
    })
    it("keeps one zone of a round robin stack whose zones all have the same sequence", () => {
        const {boxGraph, device, main, file} = setup()
        main.roundRobin.setValue(1)
        const zones = ["a.wav", "b.wav", "c.wav"].map(name => SamplerZones.create(boxGraph, device, main, file(name)))
        const other = SamplerZones.create(boxGraph, device, main, file("d.wav"))
        other.keyLow.setValue(60)
        boxGraph.endTransaction()
        const {instrument, files, skipped} = SamplerSoundfontExport.describe(device)
        expect(instrument.zones).toHaveLength(2)
        expect(files[0]).toBe(zones[0].file.targetVertex.unwrap().box)
        expect(skipped).toBe(2)
    })
    it("keeps every layer of a stack when the group has no round robin", () => {
        const {boxGraph, device, main, file} = setup()
        ;["a.wav", "b.wav"].forEach(name => SamplerZones.create(boxGraph, device, main, file(name)))
        boxGraph.endTransaction()
        const {instrument, skipped} = SamplerSoundfontExport.describe(device)
        expect(instrument.zones).toHaveLength(2)
        expect(skipped).toBe(0)
    })
    it("carries the choke of each group, the envelope and a lowpass filter", () => {
        const {boxGraph, device, main, file} = setup()
        main.choke.setValue(4)
        SamplerZones.create(boxGraph, device, main, file("a.wav"))
        device.filterType.setValue(1)
        device.cutoff.setValue(800)
        device.ampEnvelope.release.setValue(2)
        boxGraph.endTransaction()
        const {instrument} = SamplerSoundfontExport.describe(device)
        expect(instrument.groups).toEqual([{label: "Main", roundRobin: 0, choke: 4, trigger: 0}])
        expect(instrument.envelope?.release).toBe(2)
        expect(instrument.filter?.cutoff).toBe(800)
    })
    it("has no filter when the filter is off or a highpass", () => {
        const {boxGraph, device} = setup()
        device.filterType.setValue(3)
        boxGraph.endTransaction()
        expect(SamplerSoundfontExport.describe(device).instrument.filter).toBeUndefined()
    })
})
