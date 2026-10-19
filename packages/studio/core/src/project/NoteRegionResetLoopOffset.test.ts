import {describe, expect, it} from "vitest"
import {int, isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {LoopableRegion, ppqn, PPQN} from "@opendaw/lib-dsp"
import {NoteRegionBoxAdapter, ProjectSkeleton, RegionEditing, TrackType} from "@opendaw/studio-adapters"
import {NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "./ProjectEnv"

// NoteRegionBoxAdapter.resetLoopOffset moves a region's loop start back to the region start (loopOffset 0)
// and rotates the notes by the old phase, so the region keeps playing the same notes at the same times.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const createSampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None},
        get peaks() {return Option.None},
        get uuid() {return uuid},
        get state() {return {type: "idle"} as const},
        invalidate() {},
        subscribe: () => Terminable.Empty
    }),
    record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createEnv = (): ProjectEnv => ({
    audioContext: undefined, audioWorklets: undefined, sampleManager: createSampleManager(),
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const Beat = PPQN.Quarter
const Bar = PPQN.Bar

type Note = { position: ppqn, duration: ppqn, pitch: int, playCount: int }
type Span = { position: ppqn, duration: ppqn, loopOffset: ppqn, loopDuration: ppqn }
type Played = { start: ppqn, pitch: int, length: ppqn }

const note = (position: ppqn, duration: ppqn, pitch: int, playCount: int = 1): Note =>
    ({position, duration, pitch, playCount})

// A 1-bar bass loop: C2 on beat 1 (an eighth), G2 on beat 2, C3 on beat 3, Bb2 on beat 4 held to the bar line.
const Bass: ReadonlyArray<Note> = [
    note(0, Beat / 2, 36), note(Beat, Beat, 43), note(Beat * 2, Beat, 48), note(Beat * 3, Beat, 46)
]

// The 1-bar loop played four times with its left edge trimmed in by one beat: it opens on G2.
const Trimmed: Span = {position: Beat, duration: Bar * 4 - Beat, loopOffset: Beat, loopDuration: Bar}

// All regions share one collection, so more than one span makes them mirrors.
const buildProject = async (spans: ReadonlyArray<Span>, notes: ReadonlyArray<Note>) => {
    const {Project} = await import("./Project")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const {boxGraph, mandatoryBoxes: {primaryAudioUnitBox}} = skeleton
    boxGraph.beginTransaction()
    const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.type.setValue(TrackType.Notes)
        box.tracks.refer(primaryAudioUnitBox.tracks)
        box.target.refer(primaryAudioUnitBox)
    })
    const collectionBox = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    notes.forEach(({position, duration, pitch, playCount}) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(duration)
        box.pitch.setValue(pitch)
        box.playCount.setValue(playCount)
        box.events.refer(collectionBox.events)
    }))
    const regionBoxes = spans.map(({position, duration, loopOffset, loopDuration}) =>
        NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.loopOffset.setValue(loopOffset)
            box.loopDuration.setValue(loopDuration)
            box.regions.refer(trackBox.regions)
            box.events.refer(collectionBox.owners)
        }))
    boxGraph.endTransaction()
    const project = Project.fromSkeleton(createEnv(), skeleton)
    const regions = regionBoxes.map(box => project.boxAdapters.adapterFor(box, NoteRegionBoxAdapter))
    return {project, regions, collectionBox}
}

const collectionOf = (region: NoteRegionBoxAdapter) => region.optCollection.unwrap("collection")

const notesOf = (region: NoteRegionBoxAdapter): ReadonlyArray<Note> => collectionOf(region).events.asArray()
    .map(({position, duration, pitch, playCount}) => ({position, duration, pitch, playCount}))

const byStartAndPitch = (left: Played, right: Played) => left.start - right.start || left.pitch - right.pitch

// What the engine plays for a region, after crates/engine-env/src/note_sequencer.rs (chance 100, linear curve):
// a plain note plays when it starts inside the pass, cut at min(pass end, region end) when truncating;
// a ratchet repeat plays when it starts inside the pass and ignores the truncate end.
const played = (region: NoteRegionBoxAdapter, truncate: boolean): ReadonlyArray<Played> => {
    const events = collectionOf(region).events.asArray()
    const result: Array<Played> = []
    for (const {rawStart, rawEnd, resultStart, resultEnd}
        of LoopableRegion.locateLoops(region, region.position, region.complete)) {
        const localFrom = resultStart - rawStart
        const localTo = resultEnd - rawStart
        const end = truncate ? Math.min(rawEnd, region.complete) - rawStart : Number.POSITIVE_INFINITY
        events.forEach(event => {
            const {position, duration, pitch, playCount} = event
            if (playCount > 1) {
                for (let index = 0; index < playCount; index++) {
                    const from = event.computeCurveValue(index / playCount) * duration
                    const to = event.computeCurveValue((index + 1) / playCount) * duration
                    const local = position + from
                    if (localFrom <= local && local < localTo) {
                        result.push({start: rawStart + local, pitch, length: to - from})
                    }
                }
            } else if (localFrom <= position && position < localTo) {
                result.push({start: rawStart + position, pitch, length: Math.min(duration, end - position)})
            }
        })
    }
    return result.toSorted(byStartAndPitch)
}

describe("NoteRegionBoxAdapter.resetLoopOffset", () => {
    // 960, -2880 and 4800 all describe the same one-beat phase of a 1-bar loop.
    it.each([Beat, Beat - Bar, Beat + Bar])(
        "plays every note at the same time and length with truncate off (loopOffset %d)", async (loopOffset) => {
            const notes = [...Bass, note(Beat / 2, Beat, 60), note(Beat * 3.5, Beat, 72)]
            const {project, regions: [region]} = await buildProject([{...Trimmed, loopOffset}], notes)
            const before = played(region, false)
            // The first pass opens on G2 and plays four of the six notes, the three passes after it all six.
            expect(before).toHaveLength(22)
            project.editing.modify(() => region.resetLoopOffset(false))
            expect(region.loopOffset).toBe(0)
            expect(region.position).toBe(Beat)
            expect(region.duration).toBe(Bar * 4 - Beat)
            expect(region.loopDuration).toBe(Bar)
            expect(notesOf(region)).toEqual([
                note(0, Beat, 43), note(Beat, Beat, 48), note(Beat * 2, Beat, 46),
                note(Beat * 2.5, Beat, 72), note(Beat * 3, Beat / 2, 36), note(Beat * 3.5, Beat, 60)
            ])
            expect(played(region, false)).toEqual(before)
            project.terminate()
        })

    it("shortens a note that ran past the loop end to what played, with truncate on", async () => {
        // Kick on 1 and 3, snare on 2 and 4, an open hi-hat on the 'and' of 4 that is a beat long.
        const drums = [note(0, Beat, 36), note(Beat, Beat, 38), note(Beat * 2, Beat, 36),
            note(Beat * 3, Beat / 2, 38), note(Beat * 3.5, Beat, 46)]
        const {project, regions: [region]} = await buildProject([Trimmed], drums)
        const before = played(region, true)
        expect(before.filter(entry => entry.pitch === 46).map(entry => entry.length)).toEqual(Array(4).fill(Beat / 2))
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(region.loopOffset).toBe(0)
        expect(notesOf(region)).toContainEqual(note(Beat * 2.5, Beat / 2, 46))
        expect(played(region, true)).toEqual(before)
        project.terminate()
    })

    it("stops a note that ran across the old loop start at the new loop line, with truncate on", async () => {
        const {project, regions: [region]} = await buildProject([Trimmed], [...Bass, note(Beat / 2, Beat, 60)])
        const before = played(region, true)
        expect(before.filter(entry => entry.pitch === 60).map(entry => entry.length)).toEqual(Array(3).fill(Beat))
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(notesOf(region)).toContainEqual(note(Beat * 3.5, Beat, 60))
        // The pad still starts on time but is cut where the loop now restarts: this is the documented change.
        expect(played(region, true))
            .toEqual(before.map(entry => entry.pitch === 60 ? {...entry, length: Beat / 2} : entry))
        project.terminate()
    })

    it("gives the right half of a split its own notes and leaves the left half as it was", async () => {
        const {project, regions: [region], collectionBox} =
            await buildProject([{position: 0, duration: Bar * 4, loopOffset: 0, loopDuration: Bar}], Bass)
        const before = played(region, true)
        // Split on bar 2 beat 3, keeping both halves on one collection, as the app's Shift+Alt cut does.
        // The cut is left unmarked, so the reset joins its undo step. They run as two transactions, because re-pointing
        // a region box created earlier in the same transaction leaves it resolved to the old collection (lib-box).
        const right = project.editing.modify(() =>
            RegionEditing.cut(region, Bar + Beat * 2, false).unwrap("cut"), false).unwrap("modify")
        expect(right.loopOffset).toBe(Beat * 2)
        expect(right.isMirrowed).toBe(true)
        project.editing.modify(() => right.resetLoopOffset(true))
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(region.isMirrowed).toBe(false)
        expect(collectionOf(right).box).not.toBe(collectionBox)
        expect(notesOf(region)).toEqual(Bass)
        expect(right.loopOffset).toBe(0)
        expect(notesOf(right)).toEqual([note(0, Beat, 48), note(Beat, Beat, 46), note(Beat * 2, Beat / 2, 36),
            note(Beat * 3, Beat, 43)])
        expect([...played(region, true), ...played(right, true)].toSorted(byStartAndPitch)).toEqual(before)
        expect(project.editing.undo()).toBe(true)
        expect(project.editing.canUndo()).toBe(false)
        expect(region.duration).toBe(Bar * 4)
        expect(region.isMirrowed).toBe(false)
        expect(played(region, true)).toEqual(before)
        project.terminate()
    })

    it("shares one transaction with a cut that gives the right half its own notes", async () => {
        const {project, regions: [region], collectionBox} =
            await buildProject([{position: 0, duration: Bar * 4, loopOffset: 0, loopDuration: Bar}], Bass)
        const before = played(region, true)
        const right = project.editing.modify(() => {
            const half = RegionEditing.cut(region, Bar + Beat * 2, true).unwrap("cut")
            half.resetLoopOffset(true)
            return half
        }).unwrap("modify")
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(right.loopOffset).toBe(0)
        expect(notesOf(right)).toEqual([note(0, Beat, 48), note(Beat, Beat, 46), note(Beat * 2, Beat / 2, 36),
            note(Beat * 3, Beat, 43)])
        expect([...played(region, true), ...played(right, true)].toSorted(byStartAndPitch)).toEqual(before)
        expect(project.editing.undo()).toBe(true)
        expect(project.editing.canUndo()).toBe(false)
        expect(region.duration).toBe(Bar * 4)
        expect(played(region, true)).toEqual(before)
        project.terminate()
    })

    it("leaves a region without a loop length untouched", async () => {
        const {project, regions: [region, mirror], collectionBox} = await buildProject([
            {position: 0, duration: Bar * 2, loopOffset: Beat, loopDuration: 0},
            {position: Bar * 4, duration: Bar * 2, loopOffset: Beat, loopDuration: 0}
        ], Bass)
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(region.loopOffset).toBe(Beat)
        expect(region.loopDuration).toBe(0)
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(collectionOf(mirror).box).toBe(collectionBox)
        expect(notesOf(region)).toEqual(Bass)
        expect(project.editing.canUndo()).toBe(false)
        project.terminate()
    })

    it("leaves a region whose loop already starts at the region start untouched", async () => {
        const {project, regions: [region, mirror], collectionBox} = await buildProject([
            {position: 0, duration: Bar * 2, loopOffset: 0, loopDuration: Bar},
            {position: Bar * 4, duration: Bar * 2, loopOffset: 0, loopDuration: Bar}
        ], Bass)
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(collectionOf(mirror).box).toBe(collectionBox)
        expect(notesOf(region)).toEqual(Bass)
        expect(project.editing.canUndo()).toBe(false)
        project.terminate()
    })

    it("leaves notes outside the loop where they are", async () => {
        const notes = [note(-Beat / 2, Beat, 40), ...Bass, note(Bar, Beat, 50), note(Bar + Beat, Beat, 52)]
        const {project, regions: [region]} = await buildProject([Trimmed], notes)
        project.editing.modify(() => region.resetLoopOffset(true))
        const positions = notesOf(region).map(({pitch, position}) => [pitch, position])
        expect(positions).toEqual(expect.arrayContaining([[40, -Beat / 2], [50, Bar], [52, Bar + Beat]]))
        expect(positions).toEqual(expect.arrayContaining([[43, 0], [48, Beat], [46, Beat * 2], [36, Beat * 3]]))
        project.terminate()
    })

    it("only clears a loopOffset of a whole number of loops and keeps the notes shared", async () => {
        const {project, regions: [region, mirror], collectionBox} = await buildProject([
            {position: 0, duration: Bar * 2, loopOffset: Bar, loopDuration: Bar},
            {position: Bar * 4, duration: Bar * 2, loopOffset: 0, loopDuration: Bar}
        ], Bass)
        const before = played(region, true)
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(region.loopOffset).toBe(0)
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(collectionOf(mirror).box).toBe(collectionBox)
        expect(notesOf(region)).toEqual(Bass)
        expect(played(region, true)).toEqual(before)
        project.terminate()
    })

    it.each(["own notes", "shared notes"] as const)("is undone in one step (%s)", async (label) => {
        const notes = [...Bass, note(Beat * 3.5, Beat, 72)]
        const spans: ReadonlyArray<Span> =
            label === "own notes" ? [Trimmed] : [Trimmed, {...Trimmed, position: Bar * 8}]
        const {project, regions: [region], collectionBox} = await buildProject(spans, notes)
        const before = notesOf(region)
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(notesOf(region)).not.toEqual(before)
        expect(project.editing.undo()).toBe(true)
        expect(project.editing.canUndo()).toBe(false)
        expect(region.loopOffset).toBe(Beat)
        expect(collectionOf(region).box).toBe(collectionBox)
        expect(region.isMirrowed).toBe(label === "shared notes")
        expect(notesOf(region)).toEqual(before)
        project.terminate()
    })

    it("keeps the length of a ratchet note that runs past the loop end", async () => {
        const notes = [...Bass, note(Beat * 3.5, Beat, 72, 4)]
        const {project, regions: [region]} = await buildProject([Trimmed], notes)
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(notesOf(region)).toContainEqual(note(Beat * 2.5, Beat, 72, 4))
        project.terminate()
    })

    it("lands an eighth-triplet note exactly on its tick under a 2-beat phase", async () => {
        const triplet = Beat / 3
        const {project, regions: [region]} = await buildProject(
            [{position: 0, duration: Bar * 4, loopOffset: Beat * 2, loopDuration: Bar}], [note(triplet, triplet, 60)])
        project.editing.modify(() => region.resetLoopOffset(true))
        expect(notesOf(region)).toEqual([note(Beat * 2 + triplet, triplet, 60)])
        project.terminate()
    })
})
