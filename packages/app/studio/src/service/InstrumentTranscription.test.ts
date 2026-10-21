// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vitest"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {isDefined, Option, RuntimeNotifier, Terminable, UUID} from "@opendaw/lib-std"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter, InstrumentFactories, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioUnitBox, NoteClipBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {InstrumentTranscription, InstrumentAnalyzer, InstrumentNote} from "./InstrumentTranscription"
import {AudioContentFactory} from "@opendaw/studio-core"
import type {ProjectEnv} from "@opendaw/studio-core"

vi.hoisted(() => {Reflect.set(globalThis, "AudioWorkletNode", class {})})
// Use the headless core modules; the public barrel also installs browser UI styles.
vi.mock("@opendaw/studio-core", async () => ({
    ...await import("../../../../studio/core/src/project/Project"),
    ...await import("../../../../studio/core/src/project/audio/AudioContentFactory")
}))

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
const data = AudioData.create(44100, 44100, 1)
const create = async (clip = false) => {
    const env = {audioContext: {
        currentTime: 0, sampleRate: 48000,
        createGain: () => ({connect() {}, disconnect() {}, gain: {value: 1}}),
        createStereoPanner: () => ({connect() {}, disconnect() {}, pan: {value: 0}})
    }, sampleManager: {
        getOrCreate: (uuid: UUID.Bytes) => ({uuid, data: Option.wrap(data), peaks: Option.None,
            state: {type: "loaded"}, subscribe: () => Terminable.Empty, invalidate() {}}),
        record() {}, invalidate() {}, remove() {}, register: () => Terminable.Empty
    }} as unknown as ProjectEnv
    const {Project} = await import("@opendaw/studio-core")
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    project.follow(skeleton.mandatoryBoxes.userInterfaceBoxes[0])
    const source = project.editing.modify(() => {
        const {trackBox} = project.api.createInstrument(InstrumentFactories.Tape)
        const file = AudioFileBox.create(project.boxGraph, UUID.generate(), box => {
            box.fileName.setValue("Source")
            box.endInSeconds.setValue(1)
        })
        const props = {boxGraph: project.boxGraph, targetTrack: trackBox, audioFileBox: file,
            sample: {uuid: UUID.toString(file.address.uuid), name: "Source", duration: 1, bpm: 120,
                sample_rate: 44100, origin: "import" as const}, waveformOffset: 0.1}
        return clip
            ? project.boxAdapters.adapterFor(AudioContentFactory.createNotStretchedClip({...props, index: 3}), AudioClipBoxAdapter)
            : project.boxAdapters.adapterFor(AudioContentFactory.createNotStretchedRegion({...props, position: PPQN.Bar}), AudioRegionBoxAdapter)
    }).unwrap()
    return {project, source}
}
const notes: ReadonlyArray<InstrumentNote> = [
    {start: 0.2, end: 0.5, pitch: 60, velocity: 0.8, program: 0, instrument: "Piano", isDrum: false},
    {start: 0.2, end: 0.7, pitch: 60, velocity: 0.8, program: 24, instrument: "Guitar", isDrum: false},
    {start: 0.3, end: 0.31, pitch: 36, velocity: 0.8, program: 128, instrument: "Drums", isDrum: true}
]
const events = (owner: NoteRegionBox | NoteClipBox) => owner.events.targetVertex.unwrap().box
    .asBox(NoteEventCollectionBox).events.pointerHub.incoming().map(pointer => pointer.box.asBox(NoteEventBox))
afterEach(() => vi.restoreAllMocks())

describe("instrument transcription import", () => {
    it("creates one aligned track per instrument group in one undoable edit", async () => {
        const {project, source} = await create()
        const before = project.boxGraph.boxes().length
        const analyze = vi.fn<InstrumentAnalyzer>(async () => notes)
        await InstrumentTranscription.convert(project, source, analyze)
        expect(analyze.mock.calls[0][1].start).toBeCloseTo(0.1)
        expect(analyze.mock.calls[0][1].end).toBe(1)
        const owners = project.boxGraph.boxes().filter(box => box instanceof NoteRegionBox) as NoteRegionBox[]
        expect(owners).toHaveLength(3)
        expect(owners.map(owner => owner.label.getValue()).sort()).toEqual(["Source (Drums)", "Source (Guitar)", "Source (Piano)"])
        expect(owners.every(owner => owner.position.getValue() === PPQN.Bar)).toBe(true)
        const piano = owners.find(owner => owner.label.getValue() === "Source (Piano)")!
        expect(events(piano)[0].position.getValue()).toBe(192)
        const pianoUnit = piano.regions.targetVertex.unwrap().box.asBox(TrackBox)
            .target.targetVertex.unwrap().box.asBox(AudioUnitBox)
        expect(project.userEditingManager.audioUnit.isEditing(pianoUnit.editing)).toBe(true)
        expect(owners.every(owner => project.selection.isSelected(owner))).toBe(true)
        expect(source.box.isAttached()).toBe(true)
        expect(project.editing.undo()).toBe(true)
        expect(project.boxGraph.boxes().length).toBe(before)
        expect(project.editing.redo()).toBe(true)
        expect(project.boxGraph.boxes().filter(box => box instanceof NoteRegionBox)).toHaveLength(3)
        project.terminate()
    })
    it("keeps session slot and loop triggering on every generated clip", async () => {
        const {project, source} = await create(true)
        if (source.type !== "audio-clip") {throw new Error("Clip fixture")}
        project.editing.modify(() => source.box.triggerMode.loop.setValue(false))
        await InstrumentTranscription.convert(project, source, async () => notes)
        const owners = project.boxGraph.boxes().filter(box => box instanceof NoteClipBox) as NoteClipBox[]
        expect(owners).toHaveLength(3)
        expect(owners.every(owner => owner.index.getValue() === 3 && owner.duration.getValue() === 1920
            && !owner.triggerMode.loop.getValue())).toBe(true)
        expect(project.boxGraph.boxes().some(box => box instanceof NoteRegionBox)).toBe(false)
        project.terminate()
    })
    it("does not create tracks for invalid or out-of-range notes", async () => {
        const {project, source} = await create()
        const before = project.boxGraph.boxes().length
        await InstrumentTranscription.convert(project, source, async () => [
            {...notes[0], start: NaN}, {...notes[1], start: 9, end: 10}, {...notes[2], pitch: 300}])
        expect(project.boxGraph.boxes().length).toBe(before)
        project.terminate()
    })
    it("rejects a clip offset beyond the audio before requesting model inference", async () => {
        const {project, source} = await create()
        project.editing.modify(() => source.box.waveformOffset.setValue(2))
        const analyze = vi.fn<InstrumentAnalyzer>(async () => notes)
        await InstrumentTranscription.convert(project, source, analyze)
        expect(analyze).not.toHaveBeenCalled()
        expect(project.boxGraph.boxes().some(box => box instanceof NoteRegionBox)).toBe(false)
        project.terminate()
    })
    it("limits trimmed source analysis and preserves its loop offset", async () => {
        const {project, source} = await create()
        if (source.type !== "audio-region") {throw new Error("Region fixture")}
        project.editing.modify(() => {source.box.loopOffset.setValue(480); source.box.duration.setValue(0.5)})
        const analyze = vi.fn<InstrumentAnalyzer>(async () => [{...notes[0], start: 0.4, end: 0.6}])
        await InstrumentTranscription.convert(project, source, analyze)
        expect(analyze.mock.calls[0][1].start).toBeCloseTo(0.35)
        expect(analyze.mock.calls[0][1].end).toBeCloseTo(0.85)
        const owner = project.boxGraph.boxes().find(box => box instanceof NoteRegionBox) as NoteRegionBox
        expect(owner.loopOffset.getValue()).toBe(480)
        expect(events(owner)[0].position.getValue()).toBe(576)
        project.terminate()
    })
    it("transcribes one source cycle while preserving a repeating region's duration", async () => {
        const {project, source} = await create()
        if (source.type !== "audio-region") {throw new Error("Region fixture")}
        project.editing.modify(() => {source.box.duration.setValue(3); source.box.loopOffset.setValue(480)})
        const analyze = vi.fn<InstrumentAnalyzer>(async () => notes)
        await InstrumentTranscription.convert(project, source, analyze)
        expect(analyze.mock.calls[0][1].start).toBeCloseTo(0.1)
        const owners = project.boxGraph.boxes().filter(box => box instanceof NoteRegionBox) as NoteRegionBox[]
        expect(owners.every(owner => owner.duration.getValue() === 5760 && owner.loopDuration.getValue() === 1920
            && owner.loopOffset.getValue() === 480)).toBe(true)
        project.terminate()
    })
    it("cleans up after analyzer failures and allows another conversion", async () => {
        const {project, source} = await create()
        const before = project.boxGraph.boxes().length
        await InstrumentTranscription.convert(project, source, async () => {throw new Error("GPU failed")})
        expect(project.boxGraph.boxes().length).toBe(before)
        expect(InstrumentTranscription.isRunning(project)).toBe(false)
        await InstrumentTranscription.convert(project, source, async () => notes)
        expect(project.boxGraph.boxes().filter(box => box instanceof NoteRegionBox)).toHaveLength(3)
        project.terminate()
    })
    it.each(["edit", "tempo", "delete", "terminate", "cancel"] as const)("discards a pending result after %s", async action => {
        const {project, source} = await create()
        const pending = Promise.withResolvers<ReadonlyArray<InstrumentNote>>()
        const analyze = vi.fn<InstrumentAnalyzer>(async () => pending.promise)
        let cancel = () => {}
        vi.spyOn(RuntimeNotifier, "progress").mockImplementation(request => {
            cancel = request.cancel ?? (() => {})
            return {message: "", terminate() {}}
        })
        const conversion = InstrumentTranscription.convert(project, source, analyze)
        await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
        if (action === "edit") {project.editing.modify(() => source.box.waveformOffset.setValue(0.2))}
        else if (action === "tempo") {project.editing.modify(() => project.timelineBox.bpm.setValue(130))}
        else if (action === "delete") {project.editing.modify(() => source.box.delete())}
        else if (action === "terminate") {project.terminate()}
        else {cancel()}
        pending.resolve(notes)
        await conversion
        expect(project.boxGraph.boxes().some(box => box instanceof NoteRegionBox)).toBe(false)
        expect(InstrumentTranscription.isRunning(project)).toBe(false)
        if (action !== "terminate") {project.terminate()}
    })
    it("keeps only one analysis active per project", async () => {
        const {project, source} = await create()
        const pending = Promise.withResolvers<ReadonlyArray<InstrumentNote>>()
        const analyze = vi.fn<InstrumentAnalyzer>(async () => pending.promise)
        const first = InstrumentTranscription.convert(project, source, analyze)
        await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
        await InstrumentTranscription.convert(project, source, analyze)
        expect(analyze).toHaveBeenCalledOnce()
        pending.resolve(notes)
        await first
        project.terminate()
    })
})
