import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioRegionBox, TrackBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {migrateAudioRegionOverlaps} from "./MigrateAudioRegionOverlaps"

const BPM = 120

const setup = () => {
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = ProjectSkeleton.empty({
        createDefaultUser: false, createOutputMaximizer: false
    })
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Audio)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const createRegion = (position: number, duration: number, timeBase: TimeBase): AudioRegionBox => {
        const fileBox = AudioFileBox.create(boxGraph, UUID.generate(), box => box.endInSeconds.setValue(1))
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.timeBase.setValue(timeBase)
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopDuration.setValue(duration)
            box.regions.refer(trackBox.regions)
            box.file.refer(fileBox)
            box.events.refer(events.owners)
        })
    }
    return {boxGraph, createRegion}
}

const completeOf = (region: AudioRegionBox): number => {
    const position = region.position.getValue()
    const duration = region.duration.getValue()
    return region.timeBase.getValue() === TimeBase.Seconds
        ? position + PPQN.secondsToPulses(duration, BPM)
        : position + duration
}

describe("migrateAudioRegionOverlaps", () => {
    it("heals a sub-ppqn truncation overlap between seconds-based regions", () => {
        const {boxGraph, createRegion} = setup()
        // prev ends at ppqn 5773.48 (0.5070208 s * 1920), next placed at truncated position 5773.
        const prev = createRegion(4800, 0.5070208, TimeBase.Seconds)
        const next = createRegion(5773, 0.002, TimeBase.Seconds)
        boxGraph.endTransaction()
        expect(completeOf(prev)).toBeGreaterThan(next.position.getValue())
        migrateAudioRegionOverlaps(boxGraph, BPM)
        // Healed: no longer overlaps, but still touches within the resolver's boundary tolerance.
        const gap = next.position.getValue() - completeOf(prev)
        expect(gap).toBeGreaterThanOrEqual(0)
        expect(gap).toBeLessThan(2 ** -23 * 5773 + 1e-3)
    })

    it("leaves overlaps of one ppqn or more untouched (not a truncation artifact)", () => {
        const {boxGraph, createRegion} = setup()
        // prev ends at ppqn 5775 (0.5078125 s * 1920) — 2 ppqn past next at 5773.
        const prev = createRegion(4800, 0.5078125, TimeBase.Seconds)
        createRegion(5773, 0.002, TimeBase.Seconds)
        boxGraph.endTransaction()
        const before = prev.duration.getValue()
        migrateAudioRegionOverlaps(boxGraph, BPM)
        expect(prev.duration.getValue()).toBe(before)
    })

    it("leaves non-overlapping regions untouched", () => {
        const {boxGraph, createRegion} = setup()
        const prev = createRegion(4800, 0.4, TimeBase.Seconds)
        createRegion(5773, 0.002, TimeBase.Seconds)
        boxGraph.endTransaction()
        const before = prev.duration.getValue()
        migrateAudioRegionOverlaps(boxGraph, BPM)
        expect(prev.duration.getValue()).toBe(before)
    })
})
