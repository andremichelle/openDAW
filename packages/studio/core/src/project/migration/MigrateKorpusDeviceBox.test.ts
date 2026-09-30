import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioUnitBox,
    KorpusDeviceBox,
    TrackBox,
    ValueEventBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {Field} from "@opendaw/lib-box"
import {AudioUnitType} from "@opendaw/studio-enums"
import {migrateKorpusDeviceBox} from "./MigrateKorpusDeviceBox"

const setup = (semitones: number, cents: number) => {
    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(AudioUnitType.Instrument)
        box.collection.refer(rootBox.audioUnits)
        box.output.refer(primaryAudioBusBox.input)
        box.index.setValue(1)
    })
    const korpus = KorpusDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(unit.input)
        box.deprecatedTuneB.setValue(semitones)
        box.deprecatedDetuneB.setValue(cents)
    })
    const automate = (target: Field, value: number) => {
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Value)
            box.index.setValue(0)
            box.tracks.refer(unit.tracks)
            box.target.refer(target)
        })
        const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.duration.setValue(1920)
            box.loopDuration.setValue(1920)
            box.events.refer(collection.owners)
            box.regions.refer(track.regions)
        })
        const event = ValueEventBox.create(boxGraph, UUID.generate(), box => {
            box.value.setValue(value)
            box.events.refer(collection.events)
        })
        return {track, event}
    }
    return {boxGraph, korpus, automate, commit: () => boxGraph.endTransaction()}
}

describe("migrateKorpusDeviceBox", () => {
    it("folds semitones and cents into one tune", () => {
        const {boxGraph, korpus, commit} = setup(7, 5.0)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(korpus.tuneB.getValue()).toBeCloseTo(7.05, 5)
        expect(korpus.deprecatedTuneB.getValue()).toBe(0)
        expect(korpus.deprecatedDetuneB.getValue()).toBe(0.0)
    })

    it("clamps a combined tune past the range", () => {
        const {boxGraph, korpus, commit} = setup(24, 25.0)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(korpus.tuneB.getValue()).toBe(24.0)
    })

    it("moves Tune B automation even when the knob sat at zero", () => {
        const {boxGraph, korpus, automate, commit} = setup(0, 0.0)
        const {track} = automate(korpus.deprecatedTuneB, 0.75)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(korpus.deprecatedTuneB.pointerHub.incoming().length).toBe(0)
        expect(track.target.targetVertex.unwrap().address.equals(korpus.tuneB.address)).toBe(true)
        expect(korpus.tuneB.getValue()).toBe(0.0)
    })

    it("shifts moved Tune B automation by the folded cents", () => {
        const {boxGraph, korpus, automate, commit} = setup(0, 7.0)
        const {event} = automate(korpus.deprecatedTuneB, 0.75)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(-24.0 + 48.0 * event.value.getValue()).toBeCloseTo(12.07, 4)
    })

    it("removes Detune B automation, which has no equivalent on Tune B", () => {
        const {boxGraph, korpus, automate, commit} = setup(0, 0.0)
        const {track, event} = automate(korpus.deprecatedDetuneB, 0.6)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(track.isAttached()).toBe(false)
        expect(event.isAttached()).toBe(false)
        expect(korpus.deprecatedDetuneB.pointerHub.incoming().length).toBe(0)
    })

    it("leaves a fresh Korpus untouched", () => {
        const {boxGraph, korpus, commit} = setup(0, 0.0)
        korpus.tuneB.setValue(-3.5)
        commit()
        migrateKorpusDeviceBox(boxGraph, korpus)
        expect(korpus.tuneB.getValue()).toBe(-3.5)
    })
})
