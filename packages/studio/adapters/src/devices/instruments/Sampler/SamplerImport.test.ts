import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, SamplerDeviceBox, SamplerGroupBox, SamplerZoneBox} from "@opendaw/studio-boxes"
import type {SoundFont2} from "soundfont2"
import {ProjectSkeleton} from "../../../project/ProjectSkeleton"
import {SamplerImport} from "./SamplerImport"
import {SamplerSfz} from "./SamplerSfz"
import {SamplerSoundfont} from "./SamplerSoundfont"
import {SamplerZones} from "./SamplerZones"

const zone = (overrides: Partial<SamplerImport.Zone> = {}): SamplerImport.Zone => ({
    sample: 0, group: 0, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootKey: 60, transpose: 0, tune: 0,
    keyTrack: 1, gain: 0, panning: 0, sequence: 1, reverse: false, oneShot: false, sampleStart: 0, sampleEnd: undefined,
    loopMode: 0, loopStart: 0, loopEnd: undefined, ...overrides
})

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
    })
    const device = SamplerDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    const group = SamplerZones.createGroup(boxGraph, device, "Old")
    const oldFile = AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue("old.wav"))
    SamplerZones.create(boxGraph, device, group, oldFile)
    boxGraph.endTransaction()
    const edit = <T>(procedure: () => T): T => {
        boxGraph.beginTransaction()
        const result = procedure()
        boxGraph.endTransaction()
        return result
    }
    const file = (name: string): AudioFileBox => AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue(name))
    const groupsOf = (): ReadonlyArray<SamplerGroupBox> => device.groups.pointerHub.incoming()
        .map(({box}) => box as SamplerGroupBox).sort((left, right) => left.index.getValue() - right.index.getValue())
    return {boxGraph, device, oldFile, edit, file, groupsOf}
}

describe("SamplerImport.apply", () => {
    it("replaces the zones and groups and drops the samples nothing plays any more", () => {
        const {boxGraph, device, oldFile, edit, file, groupsOf} = setup()
        const created = edit(() => SamplerImport.apply(boxGraph, device, {
            name: "Grand", envelope: undefined, filter: undefined,
            groups: [{label: "Sustain", roundRobin: 1, choke: 0, trigger: 0}, {label: "Release", roundRobin: 0, choke: 3, trigger: 1}],
            zones: [zone({keyLow: 10, keyHigh: 20, rootKey: 15}), zone({sample: 1, group: 1, gain: -6, loopMode: 2, loopStart: 5, loopEnd: 50})]
        }, [file("a.wav"), file("b.wav")]))
        expect(created).toBe(2)
        expect(oldFile.isAttached()).toBe(false)
        expect(groupsOf().map(group => [group.label.getValue(), group.roundRobin.getValue(), group.choke.getValue(), group.trigger.getValue()]))
            .toEqual([["Sustain", 1, 0, 0], ["Release", 0, 3, 1]])
        const zones = SamplerZones.zonesOf(device)
        expect(zones).toHaveLength(2)
        const second = zones.find(box => box.gain.getValue() === -6) as SamplerZoneBox
        expect(second.group.targetVertex.unwrap().box).toBe(groupsOf()[1])
        expect([second.loopMode.getValue(), second.loopStart.getValue(), second.loopEnd.getValue()]).toEqual([2, 5, 50])
        expect(device.label.getValue()).toBe("Grand")
    })
    it("leaves out zones whose sample is missing and uses a default group without groups", () => {
        const {boxGraph, device, edit, file, groupsOf} = setup()
        const created = edit(() => SamplerImport.apply(boxGraph, device, {
            name: "", envelope: undefined, filter: undefined, groups: [],
            zones: [zone(), zone({sample: 1}), zone({sample: 7})]
        }, [file("a.wav"), undefined]))
        expect(created).toBe(1)
        expect(groupsOf().map(group => group.label.getValue())).toEqual(["Group 1"])
        expect(device.label.getValue()).toBe("")
    })
    it("keeps the whole sample when no end is given and clamps what is out of range", () => {
        const {boxGraph, device, edit, file} = setup()
        edit(() => SamplerImport.apply(boxGraph, device, {
            name: "x", envelope: undefined, filter: undefined, groups: [],
            zones: [zone({keyLow: 200, keyHigh: 5, velocityLow: 0, velocityHigh: 500, rootKey: -4, transpose: 99, tune: 500, gain: 99,
                panning: -3, sequence: 0, keyTrack: 7, group: 9})]
        }, [file("a.wav")]))
        const box = SamplerZones.zonesOf(device)[0]
        expect([box.keyLow.getValue(), box.keyHigh.getValue(), box.velocityLow.getValue(), box.velocityHigh.getValue()]).toEqual([127, 127, 1, 127])
        expect([box.rootKey.getValue(), box.transpose.getValue(), box.tune.getValue(), box.gain.getValue()]).toEqual([0, 24, 100, 12])
        expect([box.panning.getValue(), box.sequence.getValue(), box.keyTrack.getValue()]).toEqual([-1, 1, 1])
        expect([box.sampleEnd.getValue(), box.loopEnd.getValue()]).toEqual([0x7FFFFFFF, 0x7FFFFFFF])
    })
    it("sets the amp envelope and the filter when the import has them", () => {
        const {boxGraph, device, edit, file} = setup()
        edit(() => SamplerImport.apply(boxGraph, device, {
            name: "x", groups: [], zones: [zone()],
            envelope: {delay: 0.1, attack: 0.2, hold: 0.3, decay: 0.4, sustain: 0.5, release: 0.6},
            filter: {cutoff: 1000, resonance: 0.25}
        }, [file("a.wav")]))
        const {delay, attack, hold, decay, sustain, release} = device.ampEnvelope
        expect([delay, attack, hold, decay, sustain, release].map(field => field.getValue()))
            .toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map(value => expect.closeTo(value, 6)))
        expect([device.filterType.getValue(), device.cutoff.getValue(), device.resonance.getValue()]).toEqual([1, 1000, 0.25])
    })
    it("leaves envelope and filter alone without them, and keeps a zero attack audible", () => {
        const {boxGraph, device, edit, file} = setup()
        edit(() => SamplerImport.apply(boxGraph, device, {name: "x", groups: [], zones: [zone()], envelope: undefined, filter: undefined}, [file("a.wav")]))
        expect(device.filterType.getValue()).toBe(0)
        expect(device.ampEnvelope.sustain.getValue()).toBe(1)
        edit(() => SamplerImport.apply(boxGraph, device, {
            name: "x", groups: [], zones: [zone()], filter: undefined,
            envelope: {delay: 0, attack: 0, hold: 0, decay: 0, sustain: 1, release: 0}
        }, [file("b.wav")]))
        expect(device.ampEnvelope.attack.getValue()).toBeCloseTo(0.001, 6)
        expect(device.ampEnvelope.release.getValue()).toBeCloseTo(0.001, 6)
    })
})

describe("SamplerImport.encodeWav", () => {
    it("writes a 16 bit file frame for frame", () => {
        const buffer = SamplerImport.encodeWav({name: "x", sampleRate: 44100, channels: [new Int16Array([1, -2, 32767]), new Int16Array([4, 5, -32768])]})
        const view = new DataView(buffer)
        const text = (offset: number): string => String.fromCharCode(...new Uint8Array(buffer, offset, 4))
        expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
        expect(buffer.byteLength).toBe(44 + 12)
        expect([view.getUint32(4, true), view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true)]).toEqual([48, 1, 2, 44100])
        expect([view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true), view.getUint32(40, true)]).toEqual([176400, 4, 16, 12])
        expect(Array.from(new Int16Array(buffer, 44, 6))).toEqual([1, 4, -2, 5, 32767, -32768])
    })
    it("cuts channels to the shortest and survives no channels", () => {
        const mono = SamplerImport.encodeWav({name: "x", sampleRate: 48000, channels: [new Int16Array([7, 8]), new Int16Array([9])]})
        expect(Array.from(new Int16Array(mono, 44, 2))).toEqual([7, 9])
        expect(SamplerImport.encodeWav({name: "x", sampleRate: 48000, channels: []}).byteLength).toBe(44)
    })
})

type FakeSample = { header: Record<string, unknown>, data: Int16Array }
const sample = (name: string, frames: number, overrides: Record<string, unknown> = {}): FakeSample => ({
    header: {name, sampleRate: 44100, originalPitch: 60, pitchCorrection: 0, startLoop: 10, endLoop: frames - 10, link: 0, type: 1, ...overrides},
    data: new Int16Array(frames).fill(100)
})
const generators = (values: Record<number, number>, ranges: Record<number, [number, number]> = {}) => ({
    generators: {
        ...Object.fromEntries(Object.entries(values).map(([type, value]) => [type, {value}])),
        ...Object.fromEntries(Object.entries(ranges).map(([type, [lo, hi]]) => [type, {range: {lo, hi}}]))
    }
})
const soundfont = (samples: ReadonlyArray<FakeSample>, instrumentZones: ReadonlyArray<object>, presetZone: object = generators({})): SoundFont2 => ({
    samples,
    presets: [{header: {name: " Piano ", bank: 0, preset: 3}, zones: [{...presetZone, instrument: {zones: instrumentZones}}]}]
}) as unknown as SoundFont2

describe("SamplerImport.apply on a device that already uses the samples", () => {
    it("keeps a file the old and the new zones share", () => {
        const {boxGraph, device, oldFile, edit} = setup()
        const created = edit(() => SamplerImport.apply(boxGraph, device,
            {name: "x", groups: [], zones: [zone()], envelope: undefined, filter: undefined}, [oldFile]))
        expect(created).toBe(1)
        expect(oldFile.isAttached()).toBe(true)
        const zones = SamplerZones.zonesOf(device)
        expect(zones).toHaveLength(1)
        expect(zones[0].file.targetVertex.unwrap().box).toBe(oldFile)
    })
})

describe("SamplerSoundfont", () => {
    it("names presets by bank and number", () => {
        expect(SamplerSoundfont.presetNames(soundfont([], []))).toEqual(["000:003  Piano "])
    })
    it("converts a zone with its ranges, root, tuning and loop", () => {
        const piano = sample("C4", 1000, {pitchCorrection: -5})
        const {instrument, samples} = SamplerSoundfont.convert(soundfont([piano], [
            {...generators({51: 1, 52: 30, 48: 100, 17: 250, 54: 1, 2: 5, 3: -5, 0: 20, 1: -30, 56: 50}, {43: [48, 59], 44: [10, 90]}), sample: piano}
        ]), 0)
        expect(instrument.name).toBe("Piano")
        expect(samples).toHaveLength(1)
        expect(samples[0]).toEqual({name: "C4", sampleRate: 44100, channels: [piano.data]})
        expect(instrument.zones[0]).toMatchObject({
            sample: 0, group: 0, keyLow: 48, keyHigh: 59, velocityLow: 10, velocityHigh: 90, rootKey: 60, transpose: 1, tune: 25,
            keyTrack: 0.5, panning: 0.5, loopMode: 2, sampleStart: 20, sampleEnd: 970, loopStart: 15, loopEnd: 985
        })
        expect(instrument.zones[0].gain).toBeCloseTo(-4, 6)
        expect(instrument.groups).toEqual([{label: "Group 1", roundRobin: 0, choke: 0, trigger: 0}])
    })
    it("reads the loop modes: none, continuous, until release", () => {
        const one = sample("s", 100)
        const modes = [0, 1, 2, 3].map(mode => SamplerSoundfont.convert(soundfont([one], [{...generators({54: mode}), sample: one}]), 0)
            .instrument.zones[0].loopMode)
        expect(modes).toEqual([0, 2, 0, 1])
    })
    it("intersects preset and instrument ranges and drops what does not overlap", () => {
        const one = sample("s", 100)
        const {instrument} = SamplerSoundfont.convert(soundfont([one], [
            {...generators({}, {43: [40, 60]}), sample: one}, {...generators({}, {43: [80, 90]}), sample: one}
        ], generators({}, {43: [50, 70], 44: [0, 64]})), 0)
        expect(instrument.zones).toHaveLength(1)
        expect(instrument.zones[0]).toMatchObject({keyLow: 50, keyHigh: 60, velocityLow: 1, velocityHigh: 64})
    })
    it("adds preset generators on top of the instrument's", () => {
        const one = sample("s", 100)
        const {instrument} = SamplerSoundfont.convert(soundfont([one], [{...generators({51: 2, 48: 50, 17: 100}), sample: one}],
            generators({51: -1, 52: 10, 48: 50, 17: -300})), 0)
        expect(instrument.zones[0]).toMatchObject({transpose: 1, tune: 10})
        expect(instrument.zones[0].gain).toBeCloseTo(-4, 6)
        expect(instrument.zones[0].panning).toBeCloseTo(-0.4, 6)
    })
    it("prefers the overriding root key and falls back when the sample has none", () => {
        const unpitched = sample("s", 100, {originalPitch: 255})
        const convert = (values: Record<number, number>) =>
            SamplerSoundfont.convert(soundfont([unpitched], [{...generators(values), sample: unpitched}]), 0).instrument.zones[0].rootKey
        expect(convert({58: 72})).toBe(72)
        expect(convert({})).toBe(60)
        expect(convert({58: -1})).toBe(60)
    })
    it("stores a sample once however many zones play it", () => {
        const one = sample("s", 100)
        const {instrument, samples} = SamplerSoundfont.convert(soundfont([one], [
            {...generators({}, {43: [0, 60]}), sample: one}, {...generators({}, {43: [61, 127]}), sample: one}
        ]), 0)
        expect(samples).toHaveLength(1)
        expect(instrument.zones.map(entry => entry.sample)).toEqual([0, 0])
    })
    it("joins a linked left and right sample into one stereo zone", () => {
        const left = sample("Piano L", 100, {type: 4, link: 1})
        const right = sample("Piano R", 100, {type: 2, link: 0})
        right.data.fill(-100)
        const {instrument, samples} = SamplerSoundfont.convert(soundfont([left, right], [
            {...generators({17: 500}), sample: right}, {...generators({17: -500}), sample: left}
        ]), 0)
        expect(instrument.zones).toHaveLength(1)
        expect(instrument.zones[0].panning).toBe(0)
        expect(samples).toHaveLength(1)
        expect(samples[0].name).toBe("Piano")
        expect(samples[0].channels).toEqual([left.data, right.data])
    })
    it("keeps linked samples apart when their zones differ", () => {
        const left = sample("L", 100, {type: 4, link: 1})
        const right = sample("R", 100, {type: 2, link: 0})
        const shorter = sample("R", 90, {type: 2, link: 0})
        const apart = SamplerSoundfont.convert(soundfont([left, right], [
            {...generators({17: -500}, {43: [0, 60]}), sample: left}, {...generators({17: 500}, {43: [61, 127]}), sample: right}
        ]), 0)
        expect(apart.instrument.zones.map(entry => entry.panning)).toEqual([-1, 1])
        expect(apart.samples).toHaveLength(2)
        const uneven = SamplerSoundfont.convert(soundfont([left, shorter], [
            {...generators({}), sample: left}, {...generators({}), sample: shorter}
        ]), 0)
        expect(uneven.samples).toHaveLength(2)
    })
    it("turns exclusive classes into choke groups", () => {
        const one = sample("s", 100)
        const {instrument} = SamplerSoundfont.convert(soundfont([one], [
            {...generators({57: 1}, {43: [42, 42]}), sample: one}, {...generators({}, {43: [36, 36]}), sample: one},
            {...generators({57: 1}, {43: [46, 46]}), sample: one}
        ]), 0)
        expect(instrument.groups.map(group => [group.label, group.choke])).toEqual([["Choke 1", 1], ["Group 1", 0]])
        expect(instrument.zones.map(entry => entry.group)).toEqual([0, 1, 0])
    })
    it("takes envelope and filter from the first zone", () => {
        const one = sample("s", 100)
        const {instrument} = SamplerSoundfont.convert(soundfont([one], [
            {...generators({34: 0, 36: 1200, 37: 200, 38: -1200, 8: 9600, 9: 480}), sample: one},
            {...generators({34: 2400}), sample: one}
        ]), 0)
        expect(instrument.envelope).toMatchObject({delay: 0, attack: 1, hold: 0, decay: 2, release: 0.5})
        expect(instrument.envelope?.sustain).toBeCloseTo(0.1, 6)
        expect(instrument.filter?.cutoff).toBeCloseTo(8.176 * 256, 3)
        expect(instrument.filter?.resonance).toBeCloseTo(0.5, 6)
    })
    it("has no filter when the soundfont leaves it open", () => {
        const one = sample("s", 100)
        expect(SamplerSoundfont.convert(soundfont([one], [{...generators({}), sample: one}]), 0).instrument.filter).toBeUndefined()
    })
    it("skips empty samples and survives a preset that does not exist", () => {
        const empty = sample("s", 0)
        expect(SamplerSoundfont.convert(soundfont([empty], [{...generators({}), sample: empty}]), 0).instrument.zones).toHaveLength(0)
        const missing = SamplerSoundfont.convert(soundfont([], []), 5)
        expect([missing.instrument.zones.length, missing.samples.length, missing.instrument.name]).toEqual([0, 0, ""])
    })
    it("keeps offsets inside the sample", () => {
        const one = sample("s", 100)
        const {instrument} = SamplerSoundfont.convert(soundfont([one], [{...generators({0: 500, 1: -500, 2: -500, 3: 500}), sample: one}]), 0)
        expect(instrument.zones[0]).toMatchObject({sampleStart: 100, sampleEnd: 100, loopStart: 0, loopEnd: 100})
    })
})

describe("SamplerSfz", () => {
    it("reads keys as numbers and as note names", () => {
        expect(["60", "c4", "C#4", "db4", "a0", "c-1", "g9"].map(SamplerSfz.parseKey)).toEqual([60, 60, 61, 61, 21, 0, 127])
        expect(["", "h4", "c", "a9", "sample"].map(SamplerSfz.parseKey)).toEqual([undefined, undefined, undefined, undefined, undefined])
        expect(SamplerSfz.parseKey("300")).toBe(127)
    })
    it("splits headers and opcodes, keeps spaces in paths, drops comments", () => {
        const sections = SamplerSfz.tokenize("// a piano\n<group> lokey=c3 hikey=d3 // range\n<region> sample=My Samples/Piano C3.wav volume=-3\n<region>sample=b.wav")
        expect(sections).toEqual([
            {header: "group", opcodes: {lokey: "c3", hikey: "d3"}},
            {header: "region", opcodes: {sample: "My Samples/Piano C3.wav", volume: "-3"}},
            {header: "region", opcodes: {sample: "b.wav"}}
        ])
    })
    it("replaces defined variables, the longest name first", () => {
        const sections = SamplerSfz.tokenize("#define $KEY 60\n#define $KEYS 61\n#include \"x.sfz\"\n<region> key=$KEY hikey=$KEYS sample=$KEY.wav")
        expect(sections[0].opcodes).toEqual({key: "60", hikey: "61", sample: "60.wav"})
    })
    it("maps a region with inherited opcodes", () => {
        const {instrument, samplePaths} = SamplerSfz.parse(
            "<control> default_path=Samples\\\n<global> ampeg_release=0.5 volume=-6\n<group> lovel=1 hivel=64\n"
            + "<region> sample=C4.wav key=c4 tune=-150 pan=50 offset=10 end=999\n<group> lovel=65\n<region> sample=E4.wav lokey=62 hikey=66 pitch_keycenter=64", "Piano")
        expect(samplePaths).toEqual(["Samples/C4.wav", "Samples/E4.wav"])
        expect(instrument.name).toBe("Piano")
        expect(instrument.zones[0]).toMatchObject({
            sample: 0, keyLow: 60, keyHigh: 60, rootKey: 60, velocityLow: 1, velocityHigh: 64, gain: -6, panning: 0.5,
            transpose: -1, tune: -50, sampleStart: 10, sampleEnd: 1000
        })
        expect(instrument.zones[1]).toMatchObject({sample: 1, keyLow: 62, keyHigh: 66, rootKey: 64, velocityLow: 65, velocityHigh: 127, gain: -6})
        expect(instrument.envelope?.release).toBe(0.5)
    })
    it("resets a group when a new master or global starts", () => {
        const {instrument} = SamplerSfz.parse("<group> volume=-12\n<region> sample=a.wav\n<master> pan=100\n<region> sample=b.wav\n<global>\n<region> sample=c.wav", "x")
        expect(instrument.zones.map(entry => [entry.gain, entry.panning])).toEqual([[-12, 0], [0, 1], [0, 0]])
    })
    it("shares one sample between regions", () => {
        const {instrument, samplePaths} = SamplerSfz.parse("<region> sample=a.wav hikey=60\n<region> sample=a.wav lokey=61", "x")
        expect(samplePaths).toEqual(["a.wav"])
        expect(instrument.zones.map(entry => entry.sample)).toEqual([0, 0])
    })
    it("reads loop modes, one shot and reverse", () => {
        const zones = SamplerSfz.parse(
            "<region> sample=a.wav loop_mode=loop_continuous loop_start=100 loop_end=199\n<region> sample=a.wav loop_mode=loop_sustain\n"
            + "<region> sample=a.wav loop_mode=one_shot direction=reverse\n<region> sample=a.wav loop_mode=no_loop loop_end=5\n<region> sample=a.wav loopstart=3 loopend=9", "x").instrument.zones
        expect(zones.map(entry => entry.loopMode)).toEqual([2, 1, 0, 0, 2])
        expect([zones[0].loopStart, zones[0].loopEnd]).toEqual([100, 200])
        expect([zones[2].oneShot, zones[2].reverse]).toEqual([true, true])
        expect([zones[4].loopStart, zones[4].loopEnd]).toEqual([3, 10])
    })
    it("groups regions by round robin, choke and trigger", () => {
        const {instrument} = SamplerSfz.parse(
            "<region> sample=a.wav seq_length=2 seq_position=1\n<region> sample=b.wav seq_length=2 seq_position=2\n"
            + "<region> sample=c.wav group=1 off_by=1\n<region> sample=d.wav trigger=release\n<region> sample=e.wav lorand=0.5 hirand=1\n"
            + "<region> sample=f.wav group=2 off_by=1", "x")
        expect(instrument.groups).toEqual([
            {label: "Group 1", roundRobin: 1, choke: 0, trigger: 0}, {label: "Choke 1", roundRobin: 0, choke: 1, trigger: 0},
            {label: "Release", roundRobin: 0, choke: 0, trigger: 1}, {label: "Group 4", roundRobin: 2, choke: 0, trigger: 0},
            {label: "Group 5", roundRobin: 0, choke: 0, trigger: 0}
        ])
        expect(instrument.zones.map(entry => entry.group)).toEqual([0, 0, 1, 2, 3, 4])
        expect(instrument.zones.map(entry => entry.sequence)).toEqual([1, 2, 1, 1, 51, 1])
    })
    it("skips regions without a sample file and ignores other headers", () => {
        const {instrument, samplePaths} = SamplerSfz.parse("<region> lokey=1\n<region> sample=*sine\n<curve> curve_index=1 v000=0\n<effect> bus=main\n<region> sample=a.wav", "x")
        expect(samplePaths).toEqual(["a.wav"])
        expect(instrument.zones).toHaveLength(1)
    })
    it("reads key tracking, envelope and filter", () => {
        const {instrument} = SamplerSfz.parse("<region> sample=a.wav pitch_keytrack=0 ampeg_attack=0.2 ampeg_sustain=50 cutoff=800 resonance=20", "x")
        expect(instrument.zones[0].keyTrack).toBe(0)
        expect(instrument.envelope).toMatchObject({attack: 0.2, sustain: 0.5})
        expect(instrument.filter).toEqual({cutoff: 800, resonance: 0.5})
    })
    it("survives an empty file and nonsense values", () => {
        expect(SamplerSfz.parse("", "x").instrument.zones).toHaveLength(0)
        const {instrument} = SamplerSfz.parse("<region> sample=a.wav lokey=zz hikey=10 lovel=abc volume=loud key=", "x")
        expect(instrument.zones[0]).toMatchObject({keyLow: 0, keyHigh: 10, velocityLow: 1, gain: 0, rootKey: 60})
    })
})
