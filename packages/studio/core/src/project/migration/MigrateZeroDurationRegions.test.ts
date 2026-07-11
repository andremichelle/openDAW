import {describe, expect, it} from "vitest"
import {UUID} from "@opendaw/lib-std"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {
    AudioFileBox,
    AudioRegionBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {PPQN, TimeBase} from "@opendaw/lib-dsp"
import {migrateZeroDurationRegions} from "./MigrateZeroDurationRegions"

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
    const createAudioRegion = (position: number, duration: number, timeBase: TimeBase): AudioRegionBox => {
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
    const createNoteRegion = (position: number, duration: number): NoteRegionBox => {
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
        })
    }
    return {boxGraph, createAudioRegion, createNoteRegion}
}

describe("migrateZeroDurationRegions", () => {
    it("removes a duration-0 seconds-based audio region and keeps positive ones", () => {
        const {boxGraph, createAudioRegion} = setup()
        const zero = createAudioRegion(4800, 0, TimeBase.Seconds)
        const healthy = createAudioRegion(9600, 1.0, TimeBase.Seconds)
        boxGraph.endTransaction()

        migrateZeroDurationRegions(boxGraph, BPM)

        expect(zero.isAttached()).toBe(false)
        expect(healthy.isAttached()).toBe(true)
    })

    it("removes a duration-0 musical audio region", () => {
        const {boxGraph, createAudioRegion} = setup()
        const zero = createAudioRegion(0, 0, TimeBase.Musical)
        boxGraph.endTransaction()

        migrateZeroDurationRegions(boxGraph, BPM)

        expect(zero.isAttached()).toBe(false)
    })

    it("removes a negative-duration region (corrupt project data)", () => {
        const {boxGraph, createNoteRegion} = setup()
        const negative = createNoteRegion(0, -960)
        const healthy = createNoteRegion(1920, PPQN.Quarter)
        boxGraph.endTransaction()

        migrateZeroDurationRegions(boxGraph, BPM)

        expect(negative.isAttached()).toBe(false)
        expect(healthy.isAttached()).toBe(true)
    })

    it("is a no-op when every region has a positive duration", () => {
        const {boxGraph, createAudioRegion, createNoteRegion} = setup()
        const a = createAudioRegion(0, 2.0, TimeBase.Seconds)
        const b = createNoteRegion(9600, PPQN.Quarter)
        boxGraph.endTransaction()

        migrateZeroDurationRegions(boxGraph, BPM)

        expect(a.isAttached()).toBe(true)
        expect(b.isAttached()).toBe(true)
    })
})
