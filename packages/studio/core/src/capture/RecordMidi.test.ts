import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Notifier, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {AudioUnitBoxAdapter, NoteRegionBoxAdapter, NoteSignal, ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {EngineWorklet} from "../EngineWorklet"
import type {RecordingStart} from "../Engine"
import type {Capture} from "./Capture"
import {RegionClipResolver} from "../ui/timeline/RegionClipResolver"

// Live error 1129: a MIDI take is created with the schema default duration of 0 and grows with
// min(loopTo - takePosition, ...). A take that starts past the loop end therefore stays at 0 for the whole
// recording, and any region edit on that track trips validateTrack before the stop-time cleanup runs.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return null}, get peaks() {return null}, get uuid() {return uuid},
        get state() {return {type: "idle"} as const}, invalidate() {}, subscribe: () => Terminable.Empty
    }), record: () => {}, invalidate: () => {}, remove: () => {}, register: () => Terminable.Empty
})

const createFakeWorklet = () => ({
    playbackTimestamp: new DefaultObservableValue(0),
    countInBeatsRemaining: new DefaultObservableValue(0),
    position: new DefaultObservableValue<ppqn>(0),
    bpm: new DefaultObservableValue(120),
    isPlaying: new DefaultObservableValue(false),
    isRecording: new DefaultObservableValue(false),
    isCountingIn: new DefaultObservableValue(false),
    markerState: new DefaultObservableValue(null),
    cpuLoad: new DefaultObservableValue(0),
    recordingStart: new MutableObservableOption<RecordingStart>(),
    ignoreNoteRegion: () => {},
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

const setup = async ({outputLatency = 0.020}: {outputLatency?: number} = {}) => {
    const {Project} = await import("../project/Project")
    const {RecordMidi} = await import("./RecordMidi")
    const audioContext = {currentTime: 0, sampleRate: 48_000, outputLatency}
    const env = {
        audioContext, audioWorklets: undefined, sampleManager: sampleManager(),
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    const audioUnit = project.boxAdapters.adapterFor(primaryAudioUnitBox, AudioUnitBoxAdapter)
    const worklet = createFakeWorklet()
    project.engine.setWorklet(worklet as unknown as EngineWorklet)
    const notifier = new Notifier<NoteSignal>()
    const capture = {audioUnitBox: primaryAudioUnitBox, addRecordedRegion: () => {}} as unknown as Capture
    const recorder = RecordMidi.start({notifier, project, capture})
    const regions = (): ReadonlyArray<NoteRegionBoxAdapter> => audioUnit.tracks.values()
        .flatMap(track => track.regions.collection.asArray())
        .filter(region => region.isNoteRegion())
    const validate = () => audioUnit.tracks.values().forEach(track => RegionClipResolver.validateTrack(track))
    const tick = (position: ppqn) => worklet.position.setValue(position)
    const record = () => worklet.isRecording.setValue(true)
    const noteOn = (pitch: number) => notifier.notify(NoteSignal.on(UUID.generate(), pitch, 1.0))
    const noteOff = (pitch: number) => notifier.notify(NoteSignal.off(UUID.generate(), pitch))
    const stop = () => {
        worklet.isRecording.setValue(false)
        project.editing.modify(() => recorder.terminate(), false)
    }
    const loop = (from: ppqn, to: ppqn) => project.editing.modify(() => {
        const {loopArea} = project.timelineBox
        loopArea.from.setValue(from)
        loopArea.to.setValue(to)
        loopArea.enabled.setValue(true)
    })
    return {project, regions, validate, tick, record, noteOn, noteOff, stop, loop}
}

describe("RecordMidi", () => {
    describe("take duration invariant", () => {
        it("keeps a take that starts past the loop end positive and lets it grow (#1129)", async () => {
            const {regions, validate, tick, record, noteOn, noteOff, stop, loop} = await setup()
            loop(0, PPQN.Bar)
            record()
            tick(PPQN.Bar * 2 + 10)
            expect(regions().length).toBe(1)
            expect(regions()[0].position).toBe(PPQN.Bar * 2)
            expect(regions()[0].duration).toBeGreaterThan(0)
            expect(() => validate()).not.toThrow()
            noteOn(60)
            tick(PPQN.Bar * 2 + PPQN.Quarter * 2 + 10)
            noteOff(60)
            expect(regions()[0].duration).toBeGreaterThanOrEqual(PPQN.Quarter * 2)
            expect(() => validate()).not.toThrow()
            stop()
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBeGreaterThan(0)
        })

        it("never exposes a zero-duration take when the first tick lands exactly on a beat", async () => {
            const {regions, validate, tick, record, loop} = await setup({outputLatency: 0})
            loop(0, PPQN.Bar * 4)
            record()
            tick(PPQN.Bar)
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBeGreaterThan(0)
            expect(() => validate()).not.toThrow()
        })

        it("opens the take after a loop wrap with a positive duration", async () => {
            const {regions, validate, tick, record, loop} = await setup()
            loop(0, PPQN.Bar)
            record()
            tick(10)
            tick(PPQN.Bar - 10)
            tick(5)
            expect(regions().length).toBe(2)
            expect(regions().map(region => region.duration > 0)).toEqual([true, true])
            expect(() => validate()).not.toThrow()
        })

        it("caps a take inside the loop at the loop end", async () => {
            const {regions, tick, record, loop} = await setup()
            loop(0, PPQN.Bar)
            record()
            tick(PPQN.Bar - PPQN.Quarter + 10)
            tick(PPQN.Bar - 5)
            expect(regions().length).toBe(1)
            expect(regions()[0].complete).toBe(PPQN.Bar)
        })
    })
})
