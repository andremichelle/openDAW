import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, EuclidDeviceBox, EuclidLaneBox} from "@opendaw/studio-boxes"
import {Euclid, ProjectSkeleton} from "@opendaw/studio-adapters"
import {migrateEuclidLaneBox} from "./MigrateEuclidLaneBox"

describe("migrateEuclidLaneBox", () => {
    const createLane = (mute: boolean, solo: boolean) => {
        const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBusBox}} =
            ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
        boxGraph.beginTransaction()
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(primaryAudioBusBox.input)
            box.index.setValue(1)
        })
        const device = EuclidDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.midiEffects))
        const lane = Euclid.createLane(boxGraph, device, 36)
        lane.mute.writeDeprecated(mute)
        lane.solo.writeDeprecated(solo)
        boxGraph.endTransaction()
        return {boxGraph, lane}
    }
    const flags = (lane: EuclidLaneBox) => Array.from({length: Euclid.Patterns}, (_, pattern) => {
        const {mute, solo} = Euclid.rhythmOf(lane, pattern)
        return [mute.getValue(), solo.getValue()]
    })
    it("carries a lane-wide mute into every pattern", () => {
        const {boxGraph, lane} = createLane(true, false)
        migrateEuclidLaneBox(boxGraph, lane)
        expect(flags(lane)).toEqual(Array.from({length: 8}, () => [true, false]))
        expect([lane.mute.getValue(), lane.solo.getValue()]).toEqual([false, false])
    })
    it("carries a lane-wide solo into every pattern", () => {
        const {boxGraph, lane} = createLane(false, true)
        migrateEuclidLaneBox(boxGraph, lane)
        expect(flags(lane)).toEqual(Array.from({length: 8}, () => [false, true]))
        expect(lane.solo.getValue()).toBe(false)
    })
    it("leaves a lane without mute and solo untouched", () => {
        const {boxGraph, lane} = createLane(false, false)
        migrateEuclidLaneBox(boxGraph, lane)
        expect(flags(lane)).toEqual(Array.from({length: 8}, () => [false, false]))
    })
})
