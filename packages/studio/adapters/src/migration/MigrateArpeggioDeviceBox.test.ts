import {describe, expect, it} from "vitest"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {clamp, UUID, ValueMapping} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {
    ArpeggioDeviceBox,
    BoxIO,
    BoxVisitor,
    DelayDeviceBox,
    LfoModulatorBox,
    ModulationBox,
    TrackBox,
    ValueClipBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {migrateArpeggioDeviceBox, migrateArpeggioModeUnit} from "./MigrateArpeggioDeviceBox"
import {DeviceMigration} from "./DeviceMigration"

type Graph = BoxGraph<BoxIO.TypeMap>

// The mappings the parameter uses before (3 modes) and after (18 modes) the migration.
const oldModes = ValueMapping.linearInteger(0, 2)
const newModes = ValueMapping.linearInteger(0, 17)

const transact = <T>(graph: Graph, run: () => T): T => {
    graph.beginTransaction()
    const result = run()
    graph.endTransaction()
    return result
}
const createArp = (graph: Graph, mode: number = 0, version: number = 0) =>
    transact(graph, () => ArpeggioDeviceBox.create(graph, UUID.generate(), box => {
        box.modeIndex.setValue(mode)
        box.version.setValue(version)
    }))
const createTrack = (graph: Graph, target: Field<Pointers.Automation>) =>
    transact(graph, () => TrackBox.create(graph, UUID.generate(), box => box.target.refer(target)))
const createCollection = (graph: Graph, units: ReadonlyArray<number>) => transact(graph, () => {
    const collection = ValueEventCollectionBox.create(graph, UUID.generate())
    units.forEach((unit, index) => ValueEventBox.create(graph, UUID.generate(), box => {
        box.events.refer(collection.events)
        box.position.setValue(index * 960)
        box.interpolation.setValue(0)
        box.value.setValue(unit)
    }))
    return collection
})
const addRegion = (graph: Graph, track: TrackBox, collection: ValueEventCollectionBox) =>
    transact(graph, () => ValueRegionBox.create(graph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.events.refer(collection.owners)
        box.duration.setValue(3840)
    }))
const addClip = (graph: Graph, track: TrackBox, collection: ValueEventCollectionBox) =>
    transact(graph, () => ValueClipBox.create(graph, UUID.generate(), box => {
        box.clips.refer(track.clips)
        box.events.refer(collection.owners)
        box.duration.setValue(3840)
    }))
const collectionOf = (owner: ValueRegionBox | ValueClipBox): ValueEventCollectionBox =>
    owner.events.targetVertex.unwrap("events").box.accept<BoxVisitor<ValueEventCollectionBox>>({
        visitValueEventCollectionBox: box => box
    })!
const units = (collection: ValueEventCollectionBox): Array<number> => collection.events.pointerHub.incoming()
    .map(pointer => pointer.box as ValueEventBox)
    .sort((left, right) => left.position.getValue() - right.position.getValue())
    .map(event => event.value.getValue())
const modes = (collection: ValueEventCollectionBox): Array<number> => units(collection).map(unit => newModes.y(unit))
const migrate = (graph: Graph, arp: ArpeggioDeviceBox) => migrateArpeggioDeviceBox(graph, arp)
const addModulation = (graph: Graph, target: Field<Pointers.Modulation>, depth: number) => transact(graph, () => {
    const lfo = LfoModulatorBox.create(graph, UUID.generate())
    return ModulationBox.create(graph, UUID.generate(), box => {
        box.source.refer(lfo.assignments)
        box.target.refer(target)
        box.depth.setValue(depth)
    })
})

describe("migrateArpeggioDeviceBox", () => {
    it("keeps static modes 0, 1, 2 and bumps the version", () => {
        for (const mode of [0, 1, 2]) {
            const graph = new BoxGraph<BoxIO.TypeMap>()
            const arp = createArp(graph, mode)
            migrate(graph, arp)
            expect(arp.modeIndex.getValue()).toBe(mode)
            expect(arp.version.getValue()).toBe(1)
        }
    })
    it("maps every old automation value onto the same mode", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const oldUnits = [0, 0.1, 0.24, 0.26, 0.5, 0.74, 0.76, 0.9, 1, -0.5, 1.5]
        const collection = createCollection(graph, oldUnits)
        addRegion(graph, createTrack(graph, arp.modeIndex), collection)
        migrate(graph, arp)
        expect(modes(collection)).toEqual(oldUnits.map(unit => oldModes.y(unit)))
        expect(units(collection).slice(0, 5)).toEqual([0, 0, 0, Math.fround(1 / 17), Math.fround(1 / 17)])
    })
    it("decodes Up, Down, UpDown exactly at the new mapping", () => {
        expect(newModes.y(migrateArpeggioModeUnit(0))).toBe(0)
        expect(newModes.y(migrateArpeggioModeUnit(0.5))).toBe(1)
        expect(newModes.y(migrateArpeggioModeUnit(1))).toBe(2)
        for (let unit = 0; unit <= 1; unit += 0.001) {
            expect(newModes.y(migrateArpeggioModeUnit(unit))).toBe(oldModes.y(unit))
        }
    })
    it("copies a collection shared with another parameter and leaves the other untouched", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const delay = transact(graph, () => DelayDeviceBox.create(graph, UUID.generate(), box => box.version.setValue(1)))
        const collection = createCollection(graph, [0, 0.5, 1])
        const ours = addRegion(graph, createTrack(graph, arp.modeIndex), collection)
        const theirs = addRegion(graph, createTrack(graph, delay.feedback), collection)
        migrate(graph, arp)
        expect(units(collectionOf(theirs))).toEqual([0, 0.5, 1])
        expect(collectionOf(theirs)).toBe(collection)
        expect(collectionOf(ours)).not.toBe(collection)
        expect(modes(collectionOf(ours))).toEqual([0, 1, 2])
    })
    it("copies a collection shared with another arp's other parameter (octaves)", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const other = createArp(graph, 0, 1)
        const collection = createCollection(graph, [0.5])
        const ours = addClip(graph, createTrack(graph, arp.modeIndex), collection)
        const theirs = addClip(graph, createTrack(graph, other.numOctaves), collection)
        migrate(graph, arp)
        expect(units(collectionOf(theirs))).toEqual([0.5])
        expect(modes(collectionOf(ours))).toEqual([1])
    })
    it("keeps regions and clips of the same mode track sharing one collection", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const collection = createCollection(graph, [0.5])
        const track = createTrack(graph, arp.modeIndex)
        const region = addRegion(graph, track, collection)
        const clip = addClip(graph, track, collection)
        migrate(graph, arp)
        expect(collectionOf(region)).toBe(collection)
        expect(collectionOf(clip)).toBe(collection)
        expect(modes(collection)).toEqual([1])
    })
    it("migrates two arps sharing one mode collection correctly for both", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const first = createArp(graph)
        const second = createArp(graph)
        const collection = createCollection(graph, [0, 0.5, 1])
        const regionFirst = addRegion(graph, createTrack(graph, first.modeIndex), collection)
        const regionSecond = addRegion(graph, createTrack(graph, second.modeIndex), collection)
        DeviceMigration.migrate(graph)
        expect(modes(collectionOf(regionFirst))).toEqual([0, 1, 2])
        expect(modes(collectionOf(regionSecond))).toEqual([0, 1, 2])
        expect(first.version.getValue()).toBe(1)
        expect(second.version.getValue()).toBe(1)
    })
    it("never migrates twice", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const collection = createCollection(graph, [1])
        addRegion(graph, createTrack(graph, arp.modeIndex), collection)
        migrate(graph, arp)
        migrate(graph, arp)
        DeviceMigration.migrate(graph)
        expect(modes(collection)).toEqual([2])
    })
    it("leaves a current arp and its automation alone", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph, 7, 1)
        const collection = createCollection(graph, [9 / 17])
        addRegion(graph, createTrack(graph, arp.modeIndex), collection)
        migrate(graph, arp)
        expect(arp.modeIndex.getValue()).toBe(7)
        expect(modes(collection)).toEqual([9])
    })
    it("creates no boxes when nothing is automated", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph, 2)
        const before = graph.boxes().length
        migrate(graph, arp)
        expect(graph.boxes().length).toBe(before)
    })
    it("does not touch automation of the other arp parameters", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const rate = createCollection(graph, [0.5])
        const octaves = createCollection(graph, [0.5])
        addRegion(graph, createTrack(graph, arp.rateIndex), rate)
        addRegion(graph, createTrack(graph, arp.numOctaves), octaves)
        migrate(graph, arp)
        expect(units(rate)).toEqual([0.5])
        expect(units(octaves)).toEqual([0.5])
    })
    it("scales Mode modulation so the old modes stay where they were", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph, 1)
        const modulation = addModulation(graph, arp.modeIndex, 0.4)
        migrate(graph, arp)
        const depth = modulation.depth.getValue()
        for (let source = -1; source <= 1; source += 0.01) {
            const oldUnit = oldModes.x(1) + source * 0.4
            if (oldUnit > 1) {continue}
            expect(newModes.y(clamp(newModes.x(1) + source * depth, 0, 1))).toBe(oldModes.y(clamp(oldUnit, 0, 1)))
        }
    })
    it("migrates the automation of a Mode modulation depth", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        const modulation = addModulation(graph, arp.modeIndex, 1)
        const collection = createCollection(graph, [0, 0.5, 1])
        addRegion(graph, createTrack(graph, modulation.depth), collection)
        migrate(graph, arp)
        expect(modulation.depth.getValue()).toBeCloseTo(2 / 17, 6)
        const depths = units(collection).map(unit => unit * 2 - 1)
        expect(depths[0]).toBeCloseTo(-2 / 17, 6)
        expect(depths[1]).toBeCloseTo(0, 6)
        expect(depths[2]).toBeCloseTo(2 / 17, 6)
    })
    it("leaves modulation of a current arp alone", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph, 0, 1)
        const modulation = addModulation(graph, arp.modeIndex, 0.4)
        migrate(graph, arp)
        expect(modulation.depth.getValue()).toBeCloseTo(0.4, 6)
    })
    it("defaults the new fields of a legacy box to the legacy behaviour", () => {
        const graph = new BoxGraph<BoxIO.TypeMap>()
        const arp = createArp(graph)
        expect(arp.order.getValue()).toBe(0)
        expect(arp.hold.getValue()).toBe(false)
        expect(arp.retrigger.getValue()).toBe(0)
        expect(arp.offset.getValue()).toBe(0)
        expect(arp.patternLength.getValue()).toBe(16)
        expect(arp.stepKinds.fields().every(field => field.getValue() === 0)).toBe(true)
        expect(arp.stepVelocities.fields().every(field => field.getValue() === 100)).toBe(true)
        expect(arp.stepGates.fields().every(field => field.getValue() === 100)).toBe(true)
        expect(arp.stepTransposes.fields().every(field => field.getValue() === 0)).toBe(true)
        expect(arp.stepOctaves.fields().every(field => field.getValue() === 0)).toBe(true)
        expect(arp.stepChances.fields().every(field => field.getValue() === 100)).toBe(true)
        expect(arp.stepRatchets.fields().every(field => field.getValue() === 1)).toBe(true)
        expect(arp.stepKinds.fields().length).toBe(64)
    })
})
