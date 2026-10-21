import {afterEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Notifier, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    NoteSignal,
    ProjectSkeleton
} from "@opendaw/studio-adapters"
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
    compensationLatency: new DefaultObservableValue(0),
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
    // the main-thread clock the recorder reads between two playhead updates
    const clock = {now: 0}
    vi.spyOn(performance, "now").mockImplementation(() => clock.now)
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
    let recorder = RecordMidi.start({notifier, project, capture})
    const restart = () => {recorder = RecordMidi.start({notifier, project, capture})}
    const regions = (): ReadonlyArray<NoteRegionBoxAdapter> => audioUnit.tracks.values()
        .flatMap(track => track.regions.collection.asArray())
        .filter(region => region.isNoteRegion())
    const notes = (): ReadonlyArray<NoteEventBoxAdapter> => regions()
        .flatMap(region => region.optCollection.mapOr(collection => collection.events.asArray(), []))
    const validate = () => audioUnit.tracks.values().forEach(track => RegionClipResolver.validateTrack(track))
    const at = (seconds: number) => {clock.now = seconds * 1000.0}
    const tick = (position: ppqn) => worklet.position.setValue(position)
    const record = () => worklet.isRecording.setValue(true)
    const noteOn = (pitch: number) => notifier.notify(NoteSignal.on(UUID.generate(), pitch, 1.0))
    const noteOff = (pitch: number) => notifier.notify(NoteSignal.off(UUID.generate(), pitch))
    // a MIDIMessageEvent carries the time the key was pressed, which can be earlier than the handler runs
    const noteOnStamped = (pitch: number, seconds: number) =>
        notifier.notify({...NoteSignal.on(UUID.generate(), pitch, 1.0), timeStamp: seconds * 1000.0})
    const noteOffStamped = (pitch: number, seconds: number) =>
        notifier.notify({...NoteSignal.off(UUID.generate(), pitch), timeStamp: seconds * 1000.0})
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
    return {project, regions, notes, validate, at, tick, record, noteOn, noteOff, noteOnStamped, noteOffStamped, stop, restart, loop}
}

describe("RecordMidi", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        localStorage.clear() // engine preferences persist, a changed allowTakes would leak into the next setup
    })
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

    describe("take labels", () => {
        it("numbers a new recording's take after the takes already on the audio unit", async () => {
            const {regions, tick, record, stop, restart} = await setup()
            record()
            tick(PPQN.Bar)
            stop()
            restart()
            record()
            tick(2 * PPQN.Bar)
            expect(regions().map(region => region.label)).toEqual(["Take 1", "Take 2"])
        })

        it("keeps counting through the loop wraps of a later recording", async () => {
            const {regions, tick, record, stop, restart, loop} = await setup()
            loop(0, PPQN.Bar)
            record()
            tick(10)
            tick(PPQN.Bar - 10)
            stop()
            restart()
            record()
            tick(10)
            tick(PPQN.Bar - 10)
            tick(5)
            expect(regions().map(region => region.label)).toEqual(["Take 1", "Take 2", "Take 3"])
        })
    })

    // The playhead position reaches the main thread only on an animation frame, about every 33 ms. A key event
    // between two updates must land where it happened, not at the last update.
    describe("note timing", () => {
        const seconds = (pulses: ppqn) => PPQN.pulsesToSeconds(pulses, 120)
        // the first update must move the position: tick(0) does not notify, and a key released before it is dropped
        const startAtBar = async () => {
            const context = await setup({outputLatency: 0})
            context.record()
            context.at(seconds(PPQN.Bar))
            context.tick(PPQN.Bar)
            return context
        }

        it("keeps the length a key was held when it is released between two playhead updates", async () => {
            const {notes, at, tick, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(seconds(PPQN.Bar + PPQN.Quarter))
            tick(PPQN.Bar + PPQN.Quarter)
            at(seconds(PPQN.Bar + PPQN.Quarter + PPQN.Quarter / 2))
            noteOff(60)
            at(seconds(PPQN.Bar + PPQN.Quarter * 2))
            tick(PPQN.Bar + PPQN.Quarter * 2)
            expect(notes().map(({position, duration}) => [position, duration])).toEqual([[0, 1440]])
        })

        it("keeps the real length of a tap shorter than one playhead update", async () => {
            const {notes, at, tick, noteOn, noteOff} = await startAtBar()
            at(seconds(PPQN.Bar) + 0.002)
            noteOn(60)
            at(seconds(PPQN.Bar) + 0.025)
            noteOff(60)
            at(seconds(PPQN.Bar) + 0.0333)
            tick(PPQN.Bar + PPQN.secondsToPulses(0.0333, 120))
            // the integer note position drops the start's fraction, so the length may round either way
            const tap = PPQN.secondsToPulses(0.023, 120)
            expect(notes()[0].duration).toBeGreaterThanOrEqual(Math.floor(tap))
            expect(notes()[0].duration).toBeLessThanOrEqual(Math.ceil(tap))
        })

        it("starts a key pressed between two playhead updates where it was pressed", async () => {
            const {notes, at, noteOn} = await startAtBar()
            at(seconds(PPQN.Bar + PPQN.SemiQuaver))
            noteOn(60)
            expect(notes()[0].position).toBe(PPQN.SemiQuaver)
        })

        it("keeps the length of a note held while no playhead update arrives", async () => {
            const {notes, at, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(seconds(PPQN.Bar) + 0.25)
            noteOff(60)
            expect(notes()[0].duration).toBe(PPQN.Quarter / 2)
        })

        it("keeps a key pressed after the loop end but before the wrap update inside the take", async () => {
            const {regions, notes, at, tick, record, noteOn, loop} = await setup({outputLatency: 0})
            loop(0, PPQN.Bar)
            record()
            at(seconds(10))
            tick(10)
            at(seconds(PPQN.Bar - 20))
            tick(PPQN.Bar - 20)
            at(seconds(PPQN.Bar + 40))
            noteOn(60)
            expect(regions().length).toBe(1)
            expect(notes()[0].position).toBe(PPQN.Bar - 20)
        })

        it("keeps a key pressed after the loop end where it was pressed when the recording does not wrap", async () => {
            const {project, notes, at, tick, record, noteOn, loop} = await setup({outputLatency: 0})
            project.engine.preferences.settings.recording.allowTakes = false
            loop(0, PPQN.Bar)
            record()
            at(seconds(10))
            tick(10)
            at(seconds(PPQN.Bar - 20))
            tick(PPQN.Bar - 20)
            at(seconds(PPQN.Bar + 40))
            noteOn(60)
            expect(notes()[0].position).toBe(PPQN.Bar + 40)
        })

        it("grows the take over a key released or pressed after the last playhead update", async () => {
            const {regions, notes, at, tick, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(seconds(PPQN.Bar + PPQN.Quarter - 20))
            tick(PPQN.Bar + PPQN.Quarter - 20)
            at(seconds(PPQN.Bar + PPQN.Quarter + 20))
            noteOff(60)
            noteOn(62)
            const [released, pressed] = notes()
            expect(released.position + released.duration).toBeLessThanOrEqual(regions()[0].duration)
            expect(pressed.position).toBeLessThan(regions()[0].duration)
        })

        it("starts a key where its MIDI event was stamped, not where a late handler sees it", async () => {
            const {notes, at, noteOnStamped} = await startAtBar()
            at(seconds(PPQN.Bar + PPQN.SemiQuaver))
            noteOnStamped(60, seconds(PPQN.Bar + 60))
            expect(notes()[0].position).toBe(60)
        })

        it("keeps the length held between the MIDI stamps of key-down and key-up", async () => {
            const {notes, at, noteOnStamped, noteOffStamped} = await startAtBar()
            at(seconds(PPQN.Bar + 100))
            noteOnStamped(60, seconds(PPQN.Bar))
            at(seconds(PPQN.Bar + 700))
            noteOffStamped(60, seconds(PPQN.Bar + 480))
            expect(notes().map(({position, duration}) => [position, duration])).toEqual([[0, 480]])
        })

        it("starts a key stamped before the last playhead update at that update", async () => {
            const {notes, at, tick, noteOnStamped} = await startAtBar()
            at(seconds(PPQN.Bar + 240))
            tick(PPQN.Bar + 240)
            noteOnStamped(60, seconds(PPQN.Bar + 200))
            expect(notes()[0].position).toBe(240)
        })

        it("treats a stamp later than now as now", async () => {
            const {notes, at, noteOnStamped} = await startAtBar()
            at(seconds(PPQN.Bar + 120))
            noteOnStamped(60, seconds(PPQN.Bar + 900))
            expect(notes()[0].position).toBe(120)
        })

        it("keeps the full length of a note held across a loop wrap", async () => {
            const {regions, notes, at, tick, record, noteOn, noteOff, loop} = await setup({outputLatency: 0})
            loop(0, PPQN.Bar)
            record()
            at(seconds(10))
            tick(10)
            at(seconds(PPQN.Bar - PPQN.Quarter + 60))
            tick(PPQN.Bar - PPQN.Quarter + 60)
            noteOn(60)
            at(seconds(PPQN.Bar + 60))
            tick(60)
            at(seconds(PPQN.Bar + 120))
            noteOff(60)
            expect(regions().length).toBe(2)
            expect(notes()[0].duration).toBe(PPQN.Quarter + 60)
        })
    })
})
