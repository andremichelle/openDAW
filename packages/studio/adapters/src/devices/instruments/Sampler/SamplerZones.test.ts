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
