import {describe, expect, it} from "vitest"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {asInstanceOf, isInstanceOf, UUID, ValueMapping} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {
    AudioFileBox,
    AudioUnitBox,
    BoxIO,
    CompressorDeviceBox,
    InstrumentCompositeCellBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {DeviceMigration} from "./DeviceMigration"
import {ProjectSkeleton} from "../project/ProjectSkeleton"
import {migrateSlotReleaseUnit} from "./MigratePlayfieldDeviceBox"

type Graph = BoxGraph<BoxIO.TypeMap>

let createUnit: (graph: Graph) => AudioUnitBox = () => {throw new Error("no skeleton")}

const createGraph = (): Graph => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
        ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    createUnit = graph => AudioUnitBox.create(graph, UUID.generate(), box => {
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
    })
    return boxGraph
}

const transact = <T>(graph: Graph, run: () => T): T => {
    graph.beginTransaction()
    const result = run()
    graph.endTransaction()
    return result
}

const createPlayfield = (graph: Graph) => transact(graph, () => {
    const unit = createUnit(graph)
    return PlayfieldDeviceBox.create(graph, UUID.generate(), box => box.host.refer(unit.input))
})

const createSlot = (graph: Graph, playfield: PlayfieldDeviceBox, setup: (box: PlayfieldSampleBox) => void) => transact(graph, () => {
    const file = AudioFileBox.create(graph, UUID.generate(), box => box.fileName.setValue("kick.wav"))
    return PlayfieldSampleBox.create(graph, UUID.generate(), box => {
        box.device.refer(playfield.samples)
        box.file.refer(file)
        setup(box)
    })
})

const createAutomation = (graph: Graph, unit: AudioUnitBox, target: Field<Pointers.Automation>,
                          units: ReadonlyArray<number>) => transact(graph, () => {
    const track = TrackBox.create(graph, UUID.generate(), box => {
        box.tracks.refer(unit.tracks)
        box.target.refer(target)
    })
    const collection = ValueEventCollectionBox.create(graph, UUID.generate())
    units.forEach((unit, index) => ValueEventBox.create(graph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(index * 960)
        box.value.setValue(unit)
    }))
    ValueRegionBox.create(graph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.duration.setValue(3840)
    })
    return {track, collection}
})

const pads = (playfield: PlayfieldDeviceBox): ReadonlyArray<InstrumentCompositeCellBox> =>
    playfield.pads.pointerHub.incoming().map(pointer => asInstanceOf(pointer.box, InstrumentCompositeCellBox))
        .sort((left, right) => left.index.getValue() - right.index.getValue())

const nanoOf = (cell: InstrumentCompositeCellBox): NanoDeviceBox =>
    asInstanceOf(cell.instrument.pointerHub.incoming()[0].box, NanoDeviceBox)

describe("migratePlayfieldDeviceBox", () => {
    it("turns every slot into a pad cell hosting a Nano that plays like the slot", () => {
        const graph = createGraph()
        const playfield = createPlayfield(graph)
        const first = createSlot(graph, playfield, box => {
            box.index.setValue(36)
            box.gate.setValue(0)
            box.pitch.setValue(-300)
            box.sampleStart.setValue(0.25)
            box.sampleEnd.setValue(0.5)
            box.attack.setValue(0.01)
            box.release.setValue(0.2)
            box.volume.setValue(-6)
            box.panning.setValue(0.5)
            box.mute.setValue(true)
            box.exclude.setValue(true)
            box.polyphone.setValue(true)
            box.icon.setValue("Drum")
            box.enabled.setValue(false)
        })
        const file = first.file.targetVertex.unwrap().box
        createSlot(graph, playfield, box => {
            box.index.setValue(38)
            box.gate.setValue(2)
            box.solo.setValue(true)
        })
        createSlot(graph, playfield, box => box.index.setValue(40))
        DeviceMigration.migrate(graph)
        expect(playfield.samples.pointerHub.incoming()).toHaveLength(0)
        expect(graph.boxes().some(box => isInstanceOf(box, PlayfieldSampleBox))).toBe(false)
        const [kick, loop, gated] = pads(playfield)
        expect([kick.index.getValue(), loop.index.getValue(), gated.index.getValue()]).toEqual([36, 38, 40])
        expect([kick.key.getValue(), kick.gain.getValue(), kick.pan.getValue()]).toEqual([60, -6, 0.5])
        expect([kick.mute.getValue(), kick.solo.getValue(), kick.exclude.getValue()]).toEqual([true, false, true])
        expect(loop.solo.getValue()).toBe(true)
        const nano = nanoOf(kick)
        expect(nano.file.targetVertex.unwrap().box).toBe(file)
        expect(nano.label.getValue()).toBe("kick.wav")
        expect(nano.icon.getValue()).toBe("Drum")
        expect(nano.enabled.getValue()).toBe(false)
        expect([nano.volume.getValue(), nano.tune.getValue(), nano.rootKey.getValue()]).toEqual([0, -300, 60])
        expect([nano.sampleStart.getValue(), nano.sampleEnd.getValue()]).toEqual([0.25, 0.5])
        expect([nano.loopStart.getValue(), nano.loopEnd.getValue()]).toEqual([0, 1])
        expect(nano.attack.getValue()).toBeCloseTo(0.01)
        expect(nano.release.getValue()).toBeCloseTo(0.2)
        expect([nano.oneShot.getValue(), nano.loop.getValue(), nano.polyphone.getValue()]).toEqual([true, false, true])
        expect([nano.fixedPitch.getValue(), nano.tail.getValue()]).toEqual([true, true])
        const looped = nanoOf(loop)
        expect([looped.oneShot.getValue(), looped.loop.getValue(), looped.loopFade.getValue()]).toEqual([false, true, expect.closeTo(0.001, 6)])
        expect([looped.loopStart.getValue(), looped.loopEnd.getValue(), looped.polyphone.getValue()]).toEqual([0, 1, false])
        expect([nanoOf(gated).oneShot.getValue(), nanoOf(gated).loop.getValue()]).toEqual([true, false])
    })

    it("moves the slot's effect chains to the cell", () => {
        const graph = createGraph()
        const playfield = createPlayfield(graph)
        const slot = createSlot(graph, playfield, box => box.index.setValue(36))
        const {midi, audio} = transact(graph, () => ({
            midi: ZeitgeistDeviceBox.create(graph, UUID.generate(), box => box.host.refer(slot.midiEffects)),
            audio: CompressorDeviceBox.create(graph, UUID.generate(), box => box.host.refer(slot.audioEffects))
        }))
        DeviceMigration.migrate(graph)
        const [cell] = pads(playfield)
        expect(midi.host.targetVertex.unwrap().address.toString()).toBe(cell.midiEffects.address.toString())
        expect(audio.host.targetVertex.unwrap().address.toString()).toBe(cell.audioEffects.address.toString())
    })

    it("moves the automation to the new parameters and rescales the release", () => {
        const graph = createGraph()
        const playfield = createPlayfield(graph)
        const slot = createSlot(graph, playfield, box => box.index.setValue(36))
        const unit = asInstanceOf(playfield.host.targetVertex.unwrap().box, AudioUnitBox)
        const volume = createAutomation(graph, unit, slot.volume, [0.25, 0.75])
        const release = createAutomation(graph, unit, slot.release, [0.0, 0.5, 1.0])
        const gate = createAutomation(graph, unit, slot.gate, [0.0, 1.0])
        DeviceMigration.migrate(graph)
        const [cell] = pads(playfield)
        const nano = nanoOf(cell)
        expect(volume.track.target.targetVertex.unwrap().address.toString()).toBe(cell.gain.address.toString())
        expect(release.track.target.targetVertex.unwrap().address.toString()).toBe(nano.release.address.toString())
        const slotMapping = ValueMapping.exponential(0.001, 5.0)
        const nanoMapping = ValueMapping.exponential(0.001, 8.0)
        const values = release.collection.events.pointerHub.incoming()
            .map(pointer => asInstanceOf(pointer.box, ValueEventBox).value.getValue())
        const seconds = values.map(unit => nanoMapping.y(unit)).sort((left, right) => left - right)
        expect(seconds).toEqual([0.0, 0.5, 1.0].map(unit => expect.closeTo(slotMapping.y(unit), 4)))
        expect(gate.track.isAttached()).toBe(false)
    })

    it("moves a sidechain from the slot to the cell", () => {
        const graph = createGraph()
        const playfield = createPlayfield(graph)
        const slot = createSlot(graph, playfield, box => box.index.setValue(36))
        const compressor = transact(graph, () => {
            const unit = createUnit(graph)
            return CompressorDeviceBox.create(graph, UUID.generate(), box => {
                box.host.refer(unit.audioEffects)
                box.sideChain.refer(slot)
            })
        })
        DeviceMigration.migrate(graph)
        const [cell] = pads(playfield)
        expect(compressor.sideChain.targetVertex.unwrap().box).toBe(cell)
    })

    it("keeps a migrated Playfield as it is", () => {
        const graph = createGraph()
        const playfield = createPlayfield(graph)
        createSlot(graph, playfield, box => box.index.setValue(36))
        DeviceMigration.migrate(graph)
        const count = graph.boxes().length
        DeviceMigration.migrate(graph)
        expect(graph.boxes().length).toBe(count)
        expect(pads(playfield)).toHaveLength(1)
    })

    it("maps the slot release automation onto the longer Nano range", () => {
        expect(migrateSlotReleaseUnit(0.0)).toBeCloseTo(0.0)
        expect(ValueMapping.exponential(0.001, 8.0).y(migrateSlotReleaseUnit(1.0))).toBeCloseTo(5.0)
    })
})
