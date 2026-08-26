import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {migrateUndefinedTracks} from "./MigrateUndefinedTracks"

const setup = () => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    let nextIndex = 1
    const createUnit = (type: AudioUnitType): AudioUnitBox =>
        AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(type)
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(nextIndex++)
        })
    const createTrack = (unit: AudioUnitBox, type: TrackType, index: number): TrackBox =>
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(type)
            box.index.setValue(index)
            box.tracks.refer(unit.tracks)
            box.target.refer(unit)
        })
    return {boxGraph, createUnit, createTrack, commit: () => boxGraph.endTransaction()}
}

const tracksOf = (unit: AudioUnitBox): ReadonlyArray<TrackBox> => unit.tracks.pointerHub.incoming()
    .map(pointer => pointer.box)
    .filter((box): box is TrackBox => box instanceof TrackBox)
    .toSorted((a, b) => a.index.getValue() - b.index.getValue())

describe("migrateUndefinedTracks", () => {
    it("deletes the legacy bus placeholder and compacts the remaining indexes", () => {
        const {boxGraph, createUnit, createTrack, commit} = setup()
        const bus = createUnit(AudioUnitType.Bus)
        const placeholder = createTrack(bus, TrackType.Undefined, 0)
        const automationA = createTrack(bus, TrackType.Value, 1)
        const automationB = createTrack(bus, TrackType.Value, 2)
        commit()

        migrateUndefinedTracks(boxGraph)

        expect(placeholder.isAttached()).toBe(false)
        const remaining = tracksOf(bus)
        expect(remaining.length).toBe(2)
        expect(remaining[0]).toBe(automationA)
        expect(remaining[0].index.getValue()).toBe(0)
        expect(remaining[1]).toBe(automationB)
        expect(remaining[1].index.getValue()).toBe(1)
    })

    it("leaves units without placeholders untouched", () => {
        const {boxGraph, createUnit, createTrack, commit} = setup()
        const unit = createUnit(AudioUnitType.Instrument)
        const notes = createTrack(unit, TrackType.Notes, 0)
        const automation = createTrack(unit, TrackType.Value, 1)
        commit()

        migrateUndefinedTracks(boxGraph)

        const remaining = tracksOf(unit)
        expect(remaining.length).toBe(2)
        expect(remaining[0]).toBe(notes)
        expect(remaining[0].index.getValue()).toBe(0)
        expect(remaining[1]).toBe(automation)
        expect(remaining[1].index.getValue()).toBe(1)
    })
})
