import {describe, expect, it} from "vitest"
import {isDefined, Option, Terminable, UUID} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"
import {NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {
    InstrumentFactories,
    NoteClipBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    ProjectSkeleton,
    TrackType
} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "@opendaw/studio-core"
import type {NoteEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"

// Report 2026-11-02: the note editor stops reacting to notes until a page refresh. The editor filters its
// selection by the events collection it saw when it opened. Consolidating a mirrored region or clip (make unique,
// dragging its content start, resetting its loop offset, or undo/redo of these) points the open region to a new
// collection, the painter follows, the selection filter does not, so every note selection is silently dropped.
// The fix: readers announce a content swap, the content editor rebuilds the editor on it.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const fakeEnv = (): ProjectEnv => ({
    audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect: () => {}, disconnect: () => {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect: () => {}, disconnect: () => {}, pan: {value: 0}})
    },
    audioWorklets: undefined,
    sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({
            get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
            get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
        }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
    },
    soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
}) as unknown as ProjectEnv

const setup = async () => {
    const {Project} = await import("@opendaw/studio-core")
    const {RegionReader} = await import("@/ui/timeline/editors/RegionReader.ts")
    const {ClipReader} = await import("@/ui/timeline/editors/ClipReader.ts")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(fakeEnv(), skeleton)
    const {editing, boxGraph, boxAdapters, timelineBoxAdapter} = project
    const {original, mirror, clip, clipMirror} = editing.modify(() => {
        const {audioUnitBox} = project.api.createInstrument(InstrumentFactories.Tape)
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.type.setValue(TrackType.Notes)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
            box.index.setValue(1)
        })
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        const regionBox = NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(trackBox.regions)
            box.events.refer(events.owners)
            box.position.setValue(0)
            box.duration.setValue(PPQN.Bar)
            box.loopDuration.setValue(PPQN.Bar)
        })
        NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(0)
            box.duration.setValue(PPQN.SemiQuaver)
            box.pitch.setValue(60)
            box.events.refer(events.events)
        })
        const original = boxAdapters.adapterFor(regionBox, NoteRegionBoxAdapter)
        const mirror = original.copyTo({position: PPQN.Bar})
        const clipBox = NoteClipBox.create(boxGraph, UUID.generate(), box => {
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
            box.index.setValue(0)
            box.duration.setValue(PPQN.Bar)
        })
        const clipMirrorBox = NoteClipBox.create(boxGraph, UUID.generate(), box => {
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
            box.index.setValue(1)
            box.duration.setValue(PPQN.Bar)
        })
        return {
            original, mirror,
            clip: boxAdapters.adapterFor(clipBox, NoteClipBoxAdapter),
            clipMirror: boxAdapters.adapterFor(clipMirrorBox, NoteClipBoxAdapter)
        }
    }, false).unwrap()
    editing.mark()
    const regionReader = RegionReader.forNoteRegionBoxAdapter(mirror, timelineBoxAdapter)
    const clipReader = ClipReader.forNoteClipBoxAdapter(clipMirror, timelineBoxAdapter)
    const editorSelection = (reader: NoteEventOwnerReader) => {
        const eventsField = reader.content.box.events
        return project.selection.createFilteredSelection(box => box instanceof NoteEventBox
            && box.events.targetVertex.contains(eventsField), {
            fx: (adapter: NoteEventBoxAdapter) => adapter.box,
            fy: vertex => boxAdapters.adapterFor(vertex.box, NoteEventBoxAdapter)
        })
    }
    const countSwaps = (reader: NoteEventOwnerReader) => {
        const counter = {count: 0}
        reader.subscribeContentChange(() => counter.count++)
        return counter
    }
    return {project, editing, original, mirror, clip, clipMirror, regionReader, clipReader, editorSelection, countSwaps}
}

describe("editor content swap (note editor freezes after consolidate)", () => {
    it("a selection filtered by the collection at open time drops notes after consolidate", async () => {
        const {editing, mirror, regionReader, editorSelection} = await setup()
        expect(mirror.isMirrowed).toBe(true)
        const stale = editorSelection(regionReader)
        editing.modify(() => mirror.consolidate())
        expect(mirror.isMirrowed).toBe(false)
        const note = regionReader.content.events.asArray()[0]
        stale.select(note)
        expect(stale.isSelected(note)).toBe(false)
    })
    it("region reader announces consolidate, and a selection rebuilt on it selects the new notes", async () => {
        const {editing, mirror, regionReader, editorSelection, countSwaps} = await setup()
        const swaps = countSwaps(regionReader)
        let selection = editorSelection(regionReader)
        regionReader.subscribeContentChange(() => {
            selection.terminate()
            selection = editorSelection(regionReader)
        })
        editing.modify(() => mirror.consolidate())
        expect(swaps.count).toBe(1)
        const note = regionReader.content.events.asArray()[0]
        selection.select(note)
        expect(selection.isSelected(note)).toBe(true)
    })
    it("region reader announces undo and redo of consolidate", async () => {
        const {editing, mirror, regionReader, countSwaps} = await setup()
        const swaps = countSwaps(regionReader)
        editing.modify(() => mirror.consolidate())
        editing.undo()
        expect(mirror.isMirrowed).toBe(true)
        editing.redo()
        expect(mirror.isMirrowed).toBe(false)
        expect(swaps.count).toBe(3)
    })
    it("region reader announces moving the content start of a mirrored region", async () => {
        const {editing, mirror, regionReader, countSwaps} = await setup()
        const swaps = countSwaps(regionReader)
        editing.modify(() => mirror.moveContentStart(PPQN.SemiQuaver))
        expect(swaps.count).toBe(1)
    })
    it("region reader stays quiet on note edits and on the other mirror's consolidate", async () => {
        const {project, editing, original, regionReader, countSwaps} = await setup()
        const swaps = countSwaps(regionReader)
        editing.modify(() => NoteEventBox.create(project.boxGraph, UUID.generate(), box => {
            box.position.setValue(PPQN.SemiQuaver)
            box.duration.setValue(PPQN.SemiQuaver)
            box.pitch.setValue(62)
            box.events.refer(regionReader.content.box.events)
        }))
        editing.modify(() => regionReader.content.events.asArray()[0].box.pitch.setValue(64))
        editing.modify(() => original.consolidate())
        expect(swaps.count).toBe(0)
    })
    it("clip reader announces consolidate", async () => {
        const {editing, clipMirror, clipReader, countSwaps} = await setup()
        const swaps = countSwaps(clipReader)
        expect(clipMirror.isMirrowed).toBe(true)
        editing.modify(() => clipMirror.consolidate())
        expect(swaps.count).toBe(1)
    })
})
