import {describe, expect, it, vi} from "vitest"
import {BoxGraph} from "@opendaw/lib-box"
import {JSONValue, Option, UUID} from "@opendaw/lib-std"
import {AudioBusBox, AudioUnitBox, BoxIO, SelectionBox, TapeDeviceBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {migrateUnsatisfiedMandatory} from "./MigrateUnsatisfiedMandatory"

// The generic half of the repair: whoever still holds a required pointer with nothing on the other end
// cannot exist. The rule names no box type, so these check it against several real ones.
//
// The corrupt state is built the way the runtime delivers it, by reloading a project with a box simply
// absent. A live transaction cannot produce it: the validator rejects both a mandatory pointer left unset
// and a target that loses its last incoming edge.

const silently = <R>(procedure: () => R): R => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = procedure()
    warn.mockRestore()
    return result
}

const emptySkeleton = () => ProjectSkeleton.empty({createDefaultUser: false, createOutputMaximizer: false})

/** Rebuild `source` without the box `removed` names, then normalize, which is what ProjectMigration does. */
const reloadWithout = (source: ProjectSkeleton, removed: UUID.Bytes): BoxGraph<BoxIO.TypeMap> => {
    const json = source.boxGraph.toJSON() as Record<string, JSONValue>
    delete json[source.boxGraph.findBox(removed).unwrap("removed").address.toString()]
    const boxGraph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
    boxGraph.fromJSON(json, false)
    silently(() => boxGraph.clearUnresolvablePointers())
    return boxGraph
}

const withUnit = (skeleton: ProjectSkeleton, unitId: UUID.Bytes): AudioUnitBox => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = skeleton
    return AudioUnitBox.create(boxGraph, unitId, box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
}

describe("migrateUnsatisfiedMandatory", () => {
    it("leaves a healthy project untouched", () => {
        const {boxGraph} = emptySkeleton()
        const before = boxGraph.boxes().length
        expect(migrateUnsatisfiedMandatory(boxGraph)).toBe(0)
        expect(boxGraph.boxes().length).toBe(before)
    })

    it("is idempotent", () => {
        const {boxGraph} = emptySkeleton()
        expect(migrateUnsatisfiedMandatory(boxGraph)).toBe(0)
        expect(migrateUnsatisfiedMandatory(boxGraph)).toBe(0)
    })

    it("does nothing while the pointer still holds an address, even a dead one", () => {
        const {boxGraph, mandatoryBoxes: {rootBox}} = emptySkeleton()
        boxGraph.beginTransaction()
        const groove = rootBox.groove.targetVertex.unwrap("groove").box
        rootBox.groove.defer()
        groove.delete()
        rootBox.groove.targetAddress = Option.wrap(groove.address)
        boxGraph.endTransaction()
        expect(migrateUnsatisfiedMandatory(boxGraph), "unresolvable is not the same as unset").toBe(0)
        expect(rootBox.isAttached()).toBe(true)
    })

    it("removes a device whose host is gone", () => {
        const source = emptySkeleton()
        const unitId = UUID.generate()
        const deviceId = UUID.generate()
        source.boxGraph.beginTransaction()
        const unit = withUnit(source, unitId)
        TapeDeviceBox.create(source.boxGraph, deviceId, box => box.host.refer(unit.input))
        source.boxGraph.endTransaction()
        const boxGraph = reloadWithout(source, unitId)
        expect(silently(() => migrateUnsatisfiedMandatory(boxGraph))).toBe(1)
        expect(boxGraph.findBox(deviceId).isEmpty()).toBe(true)
        expect(ProjectSkeleton.findMandatoryBoxes(boxGraph).rootBox.isAttached()).toBe(true)
    })

    it("removes a SelectionBox with nothing selected, which used to need its own migration", () => {
        const source = emptySkeleton()
        const selectionId = UUID.generate()
        const unitId = UUID.generate()
        source.boxGraph.beginTransaction()
        const unit = withUnit(source, unitId)
        SelectionBox.create(source.boxGraph, selectionId, box => {
            box.selection.refer(unit)
            box.selectable.refer(unit)
        })
        source.boxGraph.endTransaction()
        const boxGraph = reloadWithout(source, unitId)
        silently(() => migrateUnsatisfiedMandatory(boxGraph))
        expect(boxGraph.findBox(selectionId).isEmpty()).toBe(true)
    })

    it("counts one deletion per box, not one per unsatisfied pointer", () => {
        const source = emptySkeleton()
        const unitId = UUID.generate()
        source.boxGraph.beginTransaction()
        const unit = withUnit(source, unitId)
        SelectionBox.create(source.boxGraph, UUID.generate(), box => {
            box.selection.refer(unit)
            box.selectable.refer(unit)
        })
        source.boxGraph.endTransaction()
        const boxGraph = reloadWithout(source, unitId)
        expect(silently(() => migrateUnsatisfiedMandatory(boxGraph)),
            "one box, two dead pointers").toBe(1)
    })

    // Deleting an owner can leave the next box unsatisfied, so the pass has to keep going.
    it("cascades to a fixpoint", () => {
        const source = emptySkeleton()
        const {mandatoryBoxes: {rootBox}} = source
        const unitId = UUID.generate()
        const deviceId = UUID.generate()
        source.boxGraph.beginTransaction()
        const unit = withUnit(source, unitId)
        TapeDeviceBox.create(source.boxGraph, deviceId, box => box.host.refer(unit.input))
        source.boxGraph.endTransaction()
        // Remove what the UNIT depends on, so the unit dies first and the device only through the cascade.
        const boxGraph = reloadWithout(source, rootBox.address.uuid)
        silently(() => migrateUnsatisfiedMandatory(boxGraph))
        expect(boxGraph.findBox(unitId).isEmpty(), "the unit goes").toBe(true)
        expect(boxGraph.findBox(deviceId).isEmpty(), "and its device with it").toBe(true)
    })

    it("removes a still-reachable box, which findOrphans cannot see", () => {
        const source = emptySkeleton()
        const upstreamId = UUID.generate()
        const downstreamId = UUID.generate()
        const {boxGraph: sourceGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = source
        sourceGraph.beginTransaction()
        const upstream = AudioBusBox.create(sourceGraph, upstreamId, box => {
            box.collection.refer(rootBox.audioBusses)
            box.output.refer(primaryAudioBusBox.input)
        })
        AudioBusBox.create(sourceGraph, downstreamId, box => {
            box.collection.refer(rootBox.audioBusses)
            box.output.refer(upstream.input)
        })
        sourceGraph.endTransaction()
        const boxGraph = reloadWithout(source, upstreamId)
        const reloadedRoot = ProjectSkeleton.findMandatoryBoxes(boxGraph).rootBox
        expect(boxGraph.findOrphans(reloadedRoot).map(box => box.address.uuid)
            .some(uuid => UUID.toString(uuid) === UUID.toString(downstreamId)),
        "still reachable through rootBox.audioBusses").toBe(false)
        expect(silently(() => migrateUnsatisfiedMandatory(boxGraph))).toBe(1)
        expect(boxGraph.findBox(downstreamId).isEmpty()).toBe(true)
    })

    it("leaves no unsatisfied pointer behind", () => {
        const source = emptySkeleton()
        const unitId = UUID.generate()
        source.boxGraph.beginTransaction()
        const unit = withUnit(source, unitId)
        TapeDeviceBox.create(source.boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        source.boxGraph.endTransaction()
        const boxGraph = reloadWithout(source, unitId)
        silently(() => migrateUnsatisfiedMandatory(boxGraph))
        expect(boxGraph.edges().unsatisfiedMandatoryPointers()).toEqual([])
        expect(boxGraph.unresolvablePointers()).toEqual([])
    })
})
