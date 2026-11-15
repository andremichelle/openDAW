import {describe, expect, it} from "vitest"
import {int, UUID} from "@opendaw/lib-std"
import {AudioFileBox, AudioUnitBox, SamplerDeviceBox, SamplerGroupBox, SamplerZoneBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "../../../project/ProjectSkeleton"
import {SamplerZones} from "./SamplerZones"

const setup = (names: ReadonlyArray<string>) => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
    })
    const device = SamplerDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    const group = SamplerZones.createGroup(boxGraph, device, "Group 1")
    const zones = names.map(name => SamplerZones.create(boxGraph, device, group,
        AudioFileBox.create(boxGraph, UUID.generate(), box => box.fileName.setValue(name))))
    boxGraph.endTransaction()
    const edit = (procedure: () => void): void => {
        boxGraph.beginTransaction()
        procedure()
        boxGraph.endTransaction()
    }
    return {boxGraph, device, group, zones, edit}
}

const keys = (zone: SamplerZoneBox): [int, int, int] =>
    [zone.keyLow.getValue(), zone.rootKey.getValue(), zone.keyHigh.getValue()]
const velocities = (zone: SamplerZoneBox): [int, int] => [zone.velocityLow.getValue(), zone.velocityHigh.getValue()]
const place = (zone: SamplerZoneBox, low: int, high: int, root: int = low): void => {
    zone.keyLow.setValue(low)
    zone.keyHigh.setValue(high)
    zone.rootKey.setValue(root)
}
const layer = (zone: SamplerZoneBox, low: int, high: int): void => {
    zone.velocityLow.setValue(low)
    zone.velocityHigh.setValue(high)
}

describe("SamplerZones.parseName", () => {
    it("reads notes in scientific pitch, C4 is key 60", () => {
        expect(SamplerZones.parseName("Piano_C4.wav").key).toBe(60)
        expect(SamplerZones.parseName("Piano_A0_pp.wav").key).toBe(21)
        expect(SamplerZones.parseName("Piano_C8.wav").key).toBe(108)
        expect(SamplerZones.parseName("Organ-C-1.wav").key).toBe(0)
        expect(SamplerZones.parseName("G9.wav").key).toBe(127)
    })
    it("reads sharps, flats and lower case", () => {
        expect(SamplerZones.parseName("harp_c#3.wav").key).toBe(49)
        expect(SamplerZones.parseName("harp_Cs3.wav").key).toBe(49)
        expect(SamplerZones.parseName("harp_Db3.wav").key).toBe(49)
        expect(SamplerZones.parseName("harp_Bb3.wav").key).toBe(58)
        expect(SamplerZones.parseName("harp_b3.wav").key).toBe(59)
    })
    it("needs the note to stand on its own", () => {
        expect(SamplerZones.parseName("Take2.wav").key).toBeUndefined()
        expect(SamplerZones.parseName("Snare_v3_rr1.wav").key).toBeUndefined()
        expect(SamplerZones.parseName("Bass4Real.wav").key).toBeUndefined()
        expect(SamplerZones.parseName("kick.wav").key).toBeUndefined()
        expect(SamplerZones.parseName("").key).toBeUndefined()
    })
    it("drops notes outside the keyboard", () => {
        expect(SamplerZones.parseName("A9.wav").key).toBeUndefined()
        expect(SamplerZones.parseName("Cb-1.wav").key).toBeUndefined()
    })
    it("reads dynamics as layers in rising order", () => {
        const layers = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"].map(dynamic => SamplerZones.parseName(`x_C4_${dynamic}.wav`).layer)
        expect(layers).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
        expect(SamplerZones.parseName("x_C4_FF.wav").layer).toBe(6)
    })
    it("reads numbered layers and round robins", () => {
        expect(SamplerZones.parseName("Snare_v3_rr2.wav")).toEqual({key: undefined, layer: 3, robin: 2})
        expect(SamplerZones.parseName("Snare_vl12_RR4.wav")).toEqual({key: undefined, layer: 12, robin: 4})
        expect(SamplerZones.parseName("Tom F2 v1 rr1.wav")).toEqual({key: 41, layer: 1, robin: 1})
    })
    it("takes the last dynamic when a name holds several", () => {
        expect(SamplerZones.parseName("P_C4_ff.wav").layer).toBe(6)
        expect(SamplerZones.parseName("F_horn_C4_pp.wav").layer).toBe(1)
        expect(SamplerZones.parseName("P_C4.wav").layer).toBe(2)
    })
    it("does not take letters inside words for dynamics", () => {
        expect(SamplerZones.parseName("puff_C4.wav").layer).toBeUndefined()
        expect(SamplerZones.parseName("stiff.wav").layer).toBeUndefined()
        expect(SamplerZones.parseName("vibes_C4.wav").layer).toBeUndefined()
    })
    it("keeps a dot in the name apart from the extension", () => {
        expect(SamplerZones.parseName("Piano.C4.ff.aiff")).toEqual({key: 60, layer: 6, robin: undefined})
    })
})

describe("SamplerZones", () => {
    it("creates groups with rising indices and zones on defaults", () => {
        const {boxGraph, device, group, zones, edit} = setup(["a.wav"])
        expect(group.index.getValue()).toBe(0)
        let second: SamplerGroupBox = group
        edit(() => second = SamplerZones.createGroup(boxGraph, device, "Group 2"))
        expect([second.index.getValue(), second.label.getValue()]).toEqual([1, "Group 2"])
        expect(keys(zones[0])).toEqual([0, 60, 127])
        expect(velocities(zones[0])).toEqual([1, 127])
        expect(zones[0].enabled.getValue()).toBe(true)
        expect(zones[0].group.targetVertex.unwrap().box).toBe(group)
    })
    it("gives a new group an index above a gap", () => {
        const {boxGraph, device, group, edit} = setup([])
        edit(() => group.index.setValue(7))
        let next: SamplerGroupBox = group
        edit(() => next = SamplerZones.createGroup(boxGraph, device, "x"))
        expect(next.index.getValue()).toBe(8)
    })
    it("maps a piano from its file names", () => {
        const {zones, edit} = setup(["P_C4_pp.wav", "P_C4_ff.wav", "P_E4_pp.wav", "P_E4_ff.wav", "P_G#4_pp.wav", "P_G#4_ff.wav"])
        edit(() => SamplerZones.mapByName(zones))
        expect(keys(zones[0])).toEqual([60, 60, 62])
        expect(keys(zones[2])).toEqual([63, 64, 66])
        expect(keys(zones[4])).toEqual([67, 68, 68])
        expect(velocities(zones[0])).toEqual([1, 64])
        expect(velocities(zones[1])).toEqual([65, 127])
        expect(velocities(zones[5])).toEqual([65, 127])
    })
    it("maps round robins of a drum onto one key and numbers them", () => {
        const {zones, edit} = setup(["Snare_D2_v1_rr2.wav", "Snare_D2_v1_rr1.wav", "Snare_D2_v2_rr1.wav"])
        edit(() => SamplerZones.mapByName(zones))
        expect(zones.map(zone => zone.rootKey.getValue())).toEqual([38, 38, 38])
        expect(zones.map(zone => zone.sequence.getValue())).toEqual([2, 1, 1])
        expect(velocities(zones[0])).toEqual(velocities(zones[1]))
        expect(velocities(zones[2])).toEqual([65, 127])
        expect(SamplerZones.sharesRange(zones[0], zones[1])).toBe(true)
        expect(SamplerZones.sharesRange(zones[0], zones[2])).toBe(false)
    })
    it("leaves a zone alone whose name says nothing", () => {
        const {zones, edit} = setup(["noise.wav"])
        edit(() => place(zones[0], 10, 20, 15))
        edit(() => SamplerZones.mapByName(zones))
        expect(keys(zones[0])).toEqual([10, 15, 20])
        expect(velocities(zones[0])).toEqual([1, 127])
    })
    it("spreads keys halfway between the roots and keeps the outer edges", () => {
        const {zones, edit} = setup(["a", "b", "c"])
        edit(() => {
            place(zones[0], 40, 40)
            place(zones[1], 50, 50)
            place(zones[2], 51, 51)
        })
        edit(() => SamplerZones.spreadKeys(zones))
        expect(keys(zones[0])).toEqual([40, 40, 45])
        expect(keys(zones[1])).toEqual([46, 50, 50])
        expect(keys(zones[2])).toEqual([51, 51, 51])
    })
    it("spreads only the zones it is given", () => {
        const {zones, edit} = setup(["a", "b", "c"])
        edit(() => {
            place(zones[0], 40, 40)
            place(zones[1], 50, 50)
            place(zones[2], 60, 60)
        })
        edit(() => SamplerZones.spreadKeys([zones[0], zones[2]]))
        expect(keys(zones[0])).toEqual([40, 40, 50])
        expect(keys(zones[1])).toEqual([50, 50, 50])
        expect(keys(zones[2])).toEqual([51, 60, 60])
    })
    it("spreads round robins on one root together", () => {
        const {zones, edit} = setup(["a", "b", "c"])
        edit(() => {
            place(zones[0], 40, 40)
            place(zones[1], 40, 40)
            place(zones[2], 44, 44)
        })
        edit(() => SamplerZones.spreadKeys(zones))
        expect(keys(zones[0])).toEqual(keys(zones[1]))
        expect(keys(zones[0])).toEqual([40, 40, 42])
    })
    it("spreads velocity layers evenly per column", () => {
        const {zones, edit} = setup(["a", "b", "c", "d"])
        edit(() => {
            layer(zones[0], 1, 10)
            layer(zones[1], 11, 20)
            layer(zones[2], 21, 30)
            place(zones[3], 70, 80)
            layer(zones[3], 5, 9)
        })
        edit(() => SamplerZones.spreadVelocity(zones))
        expect(zones.slice(0, 3).map(velocities)).toEqual([[1, 42], [43, 85], [86, 127]])
        expect(velocities(zones[3])).toEqual([1, 127])
    })
    it("keeps round robins of a layer on the same velocities", () => {
        const {zones, edit} = setup(["a", "b", "c"])
        edit(() => {
            layer(zones[0], 1, 10)
            layer(zones[1], 1, 10)
            layer(zones[2], 11, 20)
        })
        edit(() => SamplerZones.spreadVelocity(zones))
        expect(zones.map(velocities)).toEqual([[1, 64], [1, 64], [65, 127]])
    })
    it("crossfades neighbours and leaves outer edges alone", () => {
        const {zones, edit} = setup(["a", "b"])
        edit(() => {
            place(zones[0], 40, 49, 45)
            place(zones[1], 50, 59, 55)
        })
        edit(() => SamplerZones.crossfade(zones))
        expect([zones[0].keyLow.getValue(), zones[0].keyHigh.getValue()]).toEqual([40, 50])
        expect([zones[1].keyLow.getValue(), zones[1].keyHigh.getValue()]).toEqual([49, 59])
        expect(zones.map(zone => zone.keyFade.getValue())).toEqual([2, 2])
        expect(zones.map(zone => zone.velocityFade.getValue())).toEqual([0, 0])
    })
    it("crossfades velocity layers", () => {
        const {zones, edit} = setup(["a", "b"])
        edit(() => {
            layer(zones[0], 1, 64)
            layer(zones[1], 65, 127)
        })
        edit(() => SamplerZones.crossfade(zones))
        expect(zones.map(velocities)).toEqual([[1, 68], [61, 127]])
        expect(zones.map(zone => zone.velocityFade.getValue())).toEqual([8, 8])
    })
    it("does not widen zones a second time", () => {
        const {zones, edit} = setup(["a", "b"])
        edit(() => {
            place(zones[0], 40, 49, 45)
            place(zones[1], 50, 59, 55)
        })
        edit(() => SamplerZones.crossfade(zones))
        edit(() => SamplerZones.crossfade(zones))
        expect([zones[0].keyHigh.getValue(), zones[1].keyLow.getValue()]).toEqual([50, 49])
    })
    it("does not crossfade zones of different groups or with a gap between", () => {
        const {boxGraph, device, zones, edit} = setup(["a", "b", "c"])
        edit(() => {
            place(zones[0], 40, 49)
            place(zones[1], 50, 59)
            place(zones[2], 62, 70)
            SamplerZones.moveToGroup([zones[1]], SamplerZones.createGroup(boxGraph, device, "other"))
        })
        edit(() => SamplerZones.crossfade(zones))
        expect(zones.map(zone => zone.keyFade.getValue())).toEqual([0, 0, 0])
    })
    it("moves the root to the lowest key", () => {
        const {zones, edit} = setup(["a"])
        edit(() => place(zones[0], 30, 50, 40))
        edit(() => SamplerZones.rootToLow(zones))
        expect(keys(zones[0])).toEqual([30, 30, 50])
    })
    it("duplicates a zone as the next round robin on the same sample", () => {
        const {boxGraph, device, zones, edit} = setup(["a"])
        edit(() => {
            place(zones[0], 30, 50, 40)
            zones[0].gain.setValue(-6)
            zones[0].loopMode.setValue(2)
        })
        let copies: ReadonlyArray<SamplerZoneBox> = []
        edit(() => copies = SamplerZones.duplicate(boxGraph, device, zones))
        expect(copies).toHaveLength(1)
        expect(SamplerZones.sharesRange(copies[0], zones[0])).toBe(true)
        expect([copies[0].sequence.getValue(), copies[0].gain.getValue(), copies[0].loopMode.getValue()]).toEqual([2, -6, 2])
        expect(copies[0].file.targetVertex.unwrap().box).toBe(zones[0].file.targetVertex.unwrap().box)
        expect(SamplerZones.zonesOf(device)).toHaveLength(2)
    })
    it("removes a zone with its sample, but keeps a sample another zone plays", () => {
        const {boxGraph, device, zones, edit} = setup(["a", "b"])
        let copy: SamplerZoneBox = zones[0]
        edit(() => copy = SamplerZones.duplicate(boxGraph, device, [zones[0]])[0])
        const [fileA, fileB] = zones.map(zone => zone.file.targetVertex.unwrap().box)
        edit(() => SamplerZones.remove([zones[0], zones[1]]))
        expect(fileA.isAttached()).toBe(true)
        expect(fileB.isAttached()).toBe(false)
        edit(() => SamplerZones.remove([copy]))
        expect(fileA.isAttached()).toBe(false)
        expect(SamplerZones.zonesOf(device)).toHaveLength(0)
    })
    it("removes two zones of one sample in one go", () => {
        const {boxGraph, device, zones, edit} = setup(["a"])
        let copy: SamplerZoneBox = zones[0]
        edit(() => copy = SamplerZones.duplicate(boxGraph, device, zones)[0])
        const file = zones[0].file.targetVertex.unwrap().box
        edit(() => SamplerZones.remove([zones[0], copy]))
        expect(file.isAttached()).toBe(false)
    })
    it("takes zones off the map and cleans them up later", () => {
        const {device, zones, edit} = setup(["a", "b", "c"])
        const files = zones.map(zone => zone.file.targetVertex.unwrap().box)
        edit(() => SamplerZones.disable([zones[0], zones[2]]))
        expect(SamplerZones.zonesOf(device)).toHaveLength(3)
        expect(files.every(file => file.isAttached())).toBe(true)
        let removed = -1
        edit(() => removed = SamplerZones.cleanUp(device))
        expect(removed).toBe(2)
        expect(SamplerZones.zonesOf(device)).toEqual([zones[1]])
        expect(files.map(file => file.isAttached())).toEqual([false, true, false])
        edit(() => removed = SamplerZones.cleanUp(device))
        expect(removed).toBe(0)
    })
    it("moves zones into another group", () => {
        const {boxGraph, device, group, zones, edit} = setup(["a", "b"])
        let other: SamplerGroupBox = group
        edit(() => other = SamplerZones.createGroup(boxGraph, device, "other"))
        edit(() => SamplerZones.moveToGroup([zones[1]], other))
        expect(zones[0].group.targetVertex.unwrap().box).toBe(group)
        expect(zones[1].group.targetVertex.unwrap().box).toBe(other)
        expect(SamplerZones.sharesRange(zones[0], zones[1])).toBe(false)
    })
})

describe("SamplerZones.addSamples", () => {
    const sample = (name: string, uuid: UUID.Bytes = UUID.generate()) =>
        ({uuid: UUID.toString(uuid), name, bpm: 0, duration: 1.5, sample_rate: 48000, origin: "import" as const})
    const groupsOf = (device: SamplerDeviceBox): ReadonlyArray<SamplerGroupBox> =>
        device.groups.pointerHub.incoming().map(({box}) => box as SamplerGroupBox)
    it("creates a zone and a file box per sample and maps them by name", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Piano C4.wav"), sample("Piano E4.wav")]))
        expect(created).toHaveLength(2)
        expect(created.map(zone => zone.rootKey.getValue())).toEqual([60, 64])
        expect(created.every(zone => zone.group.targetVertex.unwrap().box === group)).toBe(true)
        const file = created[0].file.targetVertex.unwrap().box as AudioFileBox
        expect(file.fileName.getValue()).toBe("Piano C4.wav")
        expect(file.endInSeconds.getValue()).toBe(1.5)
    })
    it("reuses the file box of a sample the project already has", () => {
        const {boxGraph, device, group, edit} = setup([])
        const uuid = UUID.generate()
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav", uuid), sample("Kick.wav", uuid)]))
        expect(created).toHaveLength(2)
        expect(created[0].file.targetVertex.unwrap().box).toBe(created[1].file.targetVertex.unwrap().box)
    })
    it("uses the first group by index when none is given", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            SamplerZones.createGroup(boxGraph, device, "Second")
            created = SamplerZones.addSamples(boxGraph, device, undefined, [sample("Kick.wav")])
        })
        expect(created[0].group.targetVertex.unwrap().box).toBe(group)
    })
    it("creates a group when the device has none", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            group.delete()
            created = SamplerZones.addSamples(boxGraph, device, undefined, [sample("Kick.wav")])
        })
        expect(groupsOf(device)).toHaveLength(1)
        expect(created[0].group.targetVertex.unwrap().box).toBe(groupsOf(device)[0])
    })
    it("does nothing without samples, not even a group", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            group.delete()
            created = SamplerZones.addSamples(boxGraph, device, undefined, [])
        })
        expect(created).toHaveLength(0)
        expect(groupsOf(device)).toHaveLength(0)
    })
})

describe("SamplerZones.duplicate of a whole stack", () => {
    it("gives every copy its own place among the round robins", () => {
        const {boxGraph, device, zones, edit} = setup(["a.wav", "b.wav"])
        edit(() => zones[1].sequence.setValue(2))
        let copies: ReadonlyArray<SamplerZoneBox> = []
        edit(() => copies = SamplerZones.duplicate(boxGraph, device, zones))
        expect(copies.map(zone => zone.sequence.getValue())).toEqual([3, 4])
    })
})

describe("SamplerZones: samples without a note in their name", () => {
    const sample = (name: string, uuid: UUID.Bytes = UUID.generate()) =>
        ({uuid: UUID.toString(uuid), name, bpm: 0, duration: 1.5, sample_rate: 48000, origin: "import" as const})
    it("a single one in an empty Sampler keeps the whole keyboard", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Pad.wav")]))
        expect(keys(created[0])).toEqual([0, 60, 127])
    })
    it("several line up from C1, each on its own key", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav"), sample("Snare.wav"), sample("Hat.wav")]))
        expect(created.map(keys)).toEqual([[36, 36, 36], [37, 37, 37], [38, 38, 38]])
    })
    it("a further one skips the keys that are taken", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav"), sample("Snare.wav")]))
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Hat.wav")]))
        expect(keys(created[0])).toEqual([38, 38, 38])
    })
    it("starts at the key it was dropped on", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav"), sample("Snare.wav")], 60))
        expect(created.map(keys)).toEqual([[60, 60, 60], [61, 61, 61]])
    })
    it("leaves named samples where their names put them and fills around them", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Tom C2.wav"), sample("Kick.wav"), sample("Snare.wav")]))
        expect(created.map(keys)).toEqual([[36, 36, 36], [37, 37, 37], [38, 38, 38]])
    })
    it("keeps layers and round robins of one instrument on one key", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group,
            [sample("Snare_v1_rr1.wav"), sample("Snare_v2_rr1.wav"), sample("Snare_v1_rr2.wav"), sample("Kick.wav")]))
        expect(created.map(zone => zone.keyLow.getValue())).toEqual([36, 36, 36, 37])
        expect(created.map(velocities)).toEqual([[1, 64], [65, 127], [1, 64], [1, 127]])
        expect(created.map(zone => zone.sequence.getValue())).toEqual([1, 1, 2, 1])
    })
    it("gives a note-less sample its own key next to named ones dropped with it", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Tom C2.wav"), sample("Kick.wav")]))
        expect(created.map(keys)).toEqual([[36, 36, 36], [37, 37, 37]])
    })
    it("looks below when every key above is taken, and stacks only when none is free", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        let pad: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            pad = SamplerZones.addSamples(boxGraph, device, group, [sample("Pad.wav")])
            pad[0].keyLow.setValue(30)
        })
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav")]))
        expect(keys(created[0])).toEqual([29, 29, 29])
        edit(() => {
            pad[0].keyLow.setValue(0)
            created[0].keyLow.setValue(0)
            created[0].keyHigh.setValue(127)
        })
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare.wav")]))
        expect(created[0].keyLow.getValue()).toBe(36)
    })
    it("turns a lone whole-keyboard sample into the first key of a kit when a second one comes", () => {
        const {boxGraph, device, group, edit} = setup([])
        let first: ReadonlyArray<SamplerZoneBox> = [], second: ReadonlyArray<SamplerZoneBox> = []
        edit(() => first = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav")]))
        edit(() => second = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare.wav")]))
        expect(keys(first[0])).toEqual([36, 36, 36])
        expect(keys(second[0])).toEqual([37, 37, 37])
    })
    it("leaves a lone sample alone that the user gave a range", () => {
        const {boxGraph, device, group, edit} = setup([])
        let first: ReadonlyArray<SamplerZoneBox> = []
        edit(() => first = SamplerZones.addSamples(boxGraph, device, group, [sample("Pad.wav")]))
        edit(() => first[0].keyLow.setValue(48))
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav")]))
        expect(keys(first[0])).toEqual([48, 60, 127])
    })
    it("takes the key that was pointed at even when it sounds at other velocities", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            const [high] = SamplerZones.addSamples(boxGraph, device, group, [sample("Hat.wav")], 60)
            high.velocityLow.setValue(64)
        })
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Soft.wav"), sample("Other.wav")], 60))
        expect(created.map(zone => zone.keyLow.getValue())).toEqual([60, 61])
    })
    it("lets round robins named in the files take turns in a group that was empty", () => {
        const {boxGraph, device, group, edit} = setup([])
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Snare_rr1.wav"), sample("Snare_rr2.wav")]))
        expect(group.roundRobin.getValue()).toBe(1)
    })
    it("does not change how a group with zones plays", () => {
        const {boxGraph, device, group, edit} = setup([])
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Piano C4.wav")]))
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Snare_rr1.wav"), sample("Snare_rr2.wav")]))
        expect(group.roundRobin.getValue()).toBe(0)
    })
    it("groups an instrument whatever separates its name from the layer", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare.wav"), sample("Snare_v2.wav"), sample("Snare v3.wav")]))
        expect(created.map(zone => zone.keyLow.getValue())).toEqual([36, 36, 36])
    })
    it("leaves a lone sample of another group on its keyboard", () => {
        const {boxGraph, device, group, edit} = setup([])
        let first: ReadonlyArray<SamplerZoneBox> = [], second: ReadonlyArray<SamplerZoneBox> = []
        edit(() => first = SamplerZones.addSamples(boxGraph, device, group, [sample("Pad.wav")]))
        edit(() => second = SamplerZones.addSamples(boxGraph, device, SamplerZones.createGroup(boxGraph, device, "Release"), [sample("Noise.wav")]))
        expect(keys(first[0])).toEqual([0, 60, 127])
        expect(keys(second[0])).toEqual([36, 36, 36])
    })
    it("joins the key of its instrument when layers come one at a time", () => {
        const {boxGraph, device, group, edit} = setup([])
        let first: ReadonlyArray<SamplerZoneBox> = [], second: ReadonlyArray<SamplerZoneBox> = []
        edit(() => first = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare_rr1.wav")]))
        edit(() => second = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare_rr2.wav")]))
        expect(keys(first[0])).toEqual([36, 36, 36])
        expect(keys(second[0])).toEqual([36, 36, 36])
        expect(second[0].sequence.getValue()).toBe(2)
        expect(group.roundRobin.getValue()).toBe(1)
    })
    it("makes a kit of a lone sample of its group even when other groups have zones", () => {
        const {boxGraph, device, group, edit} = setup([])
        let pad: ReadonlyArray<SamplerZoneBox> = [], kick: ReadonlyArray<SamplerZoneBox> = []
        edit(() => {
            pad = SamplerZones.addSamples(boxGraph, device, group, [sample("Pad.wav")])
            SamplerZones.addSamples(boxGraph, device, SamplerZones.createGroup(boxGraph, device, "Other"), [sample("Tom C5.wav")])
        })
        edit(() => kick = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav")]))
        expect(keys(pad[0])).toEqual([36, 36, 36])
        expect(keys(kick[0])).toEqual([37, 37, 37])
    })
    it("keeps off the keys other groups play", () => {
        const {boxGraph, device, group, edit} = setup([])
        let hats: ReadonlyArray<SamplerZoneBox> = []
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav"), sample("Snare.wav")]))
        edit(() => hats = SamplerZones.addSamples(boxGraph, device, SamplerZones.createGroup(boxGraph, device, "Hats"),
            [sample("Open.wav"), sample("Closed.wav")]))
        expect(hats.map(zone => zone.keyLow.getValue())).toEqual([38, 39])
    })
    it("makes room for a drop on C1 when the lone sample would take it", () => {
        const {boxGraph, device, group, edit} = setup([])
        let first: ReadonlyArray<SamplerZoneBox> = [], second: ReadonlyArray<SamplerZoneBox> = []
        edit(() => first = SamplerZones.addSamples(boxGraph, device, group, [sample("Kick.wav")]))
        edit(() => second = SamplerZones.addSamples(boxGraph, device, group, [sample("Snare.wav")], 36))
        expect(first[0].keyLow.getValue()).toBe(37)
        expect(second[0].keyLow.getValue()).toBe(36)
    })
    it("puts a sample the instrument already plays on the key it is dropped on", () => {
        const {boxGraph, device, group, edit} = setup([])
        const kick = sample("Kick.wav")
        let again: ReadonlyArray<SamplerZoneBox> = []
        edit(() => SamplerZones.addSamples(boxGraph, device, group, [kick], 36))
        edit(() => again = SamplerZones.addSamples(boxGraph, device, group, [kick], 60))
        expect(keys(again[0])).toEqual([60, 60, 60])
        expect(SamplerZones.zonesOf(device)).toHaveLength(2)
    })
    it("stops at the top of the keyboard", () => {
        const {boxGraph, device, group, edit} = setup([])
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addSamples(boxGraph, device, group, [sample("A.wav"), sample("B.wav"), sample("C.wav")], 126))
        expect(created.map(zone => zone.keyLow.getValue())).toEqual([126, 127, 125])
    })
})

describe("SamplerZones.addToStack", () => {
    const sample = (name: string) => ({uuid: UUID.toString(UUID.generate()), name, bpm: 0, duration: 1, sample_rate: 48000, origin: "import" as const})
    it("puts new zones on the range, root and group of the zone and counts the sequence on", () => {
        const {boxGraph, device, zones, edit} = setup(["a.wav"])
        edit(() => {
            place(zones[0], 40, 45, 42)
            layer(zones[0], 20, 90)
        })
        let created: ReadonlyArray<SamplerZoneBox> = []
        edit(() => created = SamplerZones.addToStack(boxGraph, device, zones[0], [sample("b.wav"), sample("c C4.wav")]))
        expect(created.map(keys)).toEqual([[40, 42, 45], [40, 42, 45]])
        expect(created.map(velocities)).toEqual([[20, 90], [20, 90]])
        expect(created.map(zone => zone.sequence.getValue())).toEqual([2, 3])
        expect(created.every(zone => SamplerZones.sharesRange(zone, zones[0]))).toBe(true)
    })
})

describe("SamplerZones.replaceSample", () => {
    const sample = (name: string, uuid: UUID.Bytes = UUID.generate()) =>
        ({uuid: UUID.toString(uuid), name, bpm: 0, duration: 1, sample_rate: 48000, origin: "import" as const})
    it("points the zone at the new sample, resets its positions and drops the sample nothing plays any more", () => {
        const {boxGraph, zones, edit} = setup(["a.wav"])
        const old = zones[0].file.targetVertex.unwrap().box
        edit(() => {
            zones[0].sampleStart.setValue(100)
            zones[0].loopEnd.setValue(500)
            SamplerZones.replaceSample(boxGraph, zones, sample("b.wav"))
        })
        const file = zones[0].file.targetVertex.unwrap().box as AudioFileBox
        expect(file.fileName.getValue()).toBe("b.wav")
        expect(old.isAttached()).toBe(false)
        expect(zones[0].sampleStart.getValue()).toBe(0)
        expect(zones[0].loopEnd.getValue()).toBe(0x7FFFFFFF)
    })
    it("keeps the old sample while another zone plays it", () => {
        const {boxGraph, device, group, zones, edit} = setup(["a.wav"])
        const old = zones[0].file.targetVertex.unwrap().box as AudioFileBox
        edit(() => {
            SamplerZones.create(boxGraph, device, group, old)
            SamplerZones.replaceSample(boxGraph, zones, sample("b.wav"))
        })
        expect(old.isAttached()).toBe(true)
    })
    it("survives replacing a sample by itself", () => {
        const {boxGraph, zones, edit} = setup(["a.wav"])
        const old = zones[0].file.targetVertex.unwrap().box as AudioFileBox
        edit(() => SamplerZones.replaceSample(boxGraph, zones, sample("a.wav", old.address.uuid)))
        expect(old.isAttached()).toBe(true)
        expect(zones[0].file.targetVertex.unwrap().box).toBe(old)
    })
})

describe("SamplerZones.reorder and removeGroup", () => {
    it("numbers the zones in the order given", () => {
        const {zones, edit} = setup(["a.wav", "b.wav", "c.wav"])
        edit(() => SamplerZones.reorder([zones[2], zones[0], zones[1]]))
        expect(zones.map(zone => zone.sequence.getValue())).toEqual([2, 3, 1])
    })
    it("removes a group with its zones and their samples", () => {
        const {boxGraph, device, group, zones, edit} = setup(["a.wav"])
        const file = zones[0].file.targetVertex.unwrap().box
        let removed = false
        edit(() => {
            SamplerZones.createGroup(boxGraph, device, "Second")
            removed = SamplerZones.removeGroup(device, group)
        })
        expect(removed).toBe(true)
        expect(group.isAttached()).toBe(false)
        expect(zones[0].isAttached()).toBe(false)
        expect(file.isAttached()).toBe(false)
        expect(device.groups.pointerHub.size()).toBe(1)
    })
    it("keeps the last group", () => {
        const {device, group, edit} = setup(["a.wav"])
        let removed = true
        edit(() => removed = SamplerZones.removeGroup(device, group))
        expect(removed).toBe(false)
        expect(group.isAttached()).toBe(true)
    })
})
