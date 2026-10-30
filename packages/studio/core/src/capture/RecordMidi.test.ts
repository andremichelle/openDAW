import {afterEach, describe, expect, it, vi} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Notifier, Observer, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {
    AudioUnitBoxAdapter,
    NoteEventBoxAdapter,
    NoteRegionBoxAdapter,
    NoteSignal,
    ProjectSkeleton,
    TransportAnchor
} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {EngineWorklet} from "../EngineWorklet"
import type {RecordingStart} from "../Engine"
import type {Capture} from "./Capture"
import type {ContextClock} from "../io"
import {RegionClipResolver} from "../ui/timeline/RegionClipResolver"

// Live error 1129: a MIDI take is created with the schema default duration of 0 and grows with
// min(loopTo - takePosition, ...). A take that starts past the loop end therefore stays at 0 for the whole
// recording, and any region edit on that track trips validateTrack before the stop-time cleanup runs.
//
// Notes are placed on the audio context clock: the engine reports where the recording started and where it
// wrapped, a key is stamped with the context time that was audible when it was pressed.

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
    anchors: new Notifier<ReadonlyArray<TransportAnchor>>(),
    subscribeTransportAnchors(observer: Observer<ReadonlyArray<TransportAnchor>>) {return this.anchors.subscribe(observer)},
    ignoreNoteRegion: () => {},
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

// the fake output plays what was rendered `outputLatency` seconds earlier
const setup = async ({outputLatency = 0}: { outputLatency?: number } = {}) => {
    const {Project} = await import("../project/Project")
    const {RecordMidi} = await import("./RecordMidi")
    const audioContext = {currentTime: 0, sampleRate: 48_000, outputLatency}
    const clock = {now: 0}
    vi.spyOn(performance, "now").mockImplementation(() => clock.now)
    const contextClock: ContextClock = {audibleTimeAt: (performanceTime: number) => performanceTime / 1000.0 - outputLatency}
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
    const startRecorder = () => RecordMidi.start({notifier, project, capture, clock: contextClock})
    let recorder = startRecorder()
    const regions = (): ReadonlyArray<NoteRegionBoxAdapter> => audioUnit.tracks.values()
        .flatMap(track => track.regions.collection.asArray())
        .filter(region => region.isNoteRegion())
    const notes = (): ReadonlyArray<NoteEventBoxAdapter> => regions()
        .flatMap(region => region.optCollection.mapOr(collection => collection.events.asArray(), []))
    const validate = () => audioUnit.tracks.values().forEach(track => RegionClipResolver.validateTrack(track))
    const at = (seconds: number) => {clock.now = seconds * 1000.0}
    let ticks = 0
    // an animation frame: the value only has to change to notify
    const tick = () => worklet.position.setValue(++ticks)
    // the engine reports the recording start at a context time, the main thread sees the flag later
    const begin = (contextTime: number, position: ppqn) => {
        worklet.recordingStart.wrap({contextTime, position})
        worklet.isRecording.setValue(true)
    }
    const wrapAt = (contextTime: number, position: ppqn) =>
        worklet.anchors.notify([{kind: "jump", contextTime, position, recording: true}])
    const noteOn = (pitch: number) => notifier.notify({...NoteSignal.on(UUID.generate(), pitch, 1.0), timeStamp: clock.now})
    const noteOff = (pitch: number) => notifier.notify({...NoteSignal.off(UUID.generate(), pitch), timeStamp: clock.now})
    // a MIDIMessageEvent carries the time the key was pressed, which can be earlier than the handler runs
    const noteOnStamped = (pitch: number, seconds: number) =>
        notifier.notify({...NoteSignal.on(UUID.generate(), pitch, 1.0), timeStamp: seconds * 1000.0})
    const noteOffStamped = (pitch: number, seconds: number) =>
        notifier.notify({...NoteSignal.off(UUID.generate(), pitch), timeStamp: seconds * 1000.0})
    const stop = () => {
        worklet.isRecording.setValue(false)
        project.editing.modify(() => recorder.terminate(), false)
    }
    const restart = () => {
        worklet.recordingStart.clear()
        recorder = startRecorder()
    }
    const loop = (from: ppqn, to: ppqn) => project.editing.modify(() => {
        const {loopArea} = project.timelineBox
        loopArea.from.setValue(from)
        loopArea.to.setValue(to)
        loopArea.enabled.setValue(true)
    })
    const compensate = (seconds: number) => worklet.compensationLatency.setValue(seconds)
    return {
        project, regions, notes, validate, at, tick, begin, wrapAt, noteOn, noteOff, noteOnStamped, noteOffStamped,
        stop, restart, loop, compensate
    }
}

// at 120 bpm
const seconds = (pulses: ppqn) => PPQN.pulsesToSeconds(pulses, 120)

describe("RecordMidi", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        localStorage.clear() // engine preferences persist, a changed allowTakes would leak into the next setup
    })
    describe("take duration invariant", () => {
        it("keeps a take that starts past the loop end positive and lets it grow (#1129)", async () => {
            const {regions, validate, at, tick, begin, noteOn, noteOff, stop, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, PPQN.Bar * 2 + 10)
            expect(regions().length).toBe(1)
            expect(regions()[0].position).toBe(PPQN.Bar * 2)
            expect(regions()[0].duration).toBeGreaterThan(0)
            expect(() => validate()).not.toThrow()
            at(1.0)
            noteOn(60)
            at(1.0 + seconds(PPQN.Quarter * 2))
            tick()
            noteOff(60)
            expect(regions()[0].duration).toBeGreaterThanOrEqual(PPQN.Quarter * 2)
            expect(() => validate()).not.toThrow()
            stop()
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBeGreaterThan(0)
        })

        it("never exposes a zero-duration take when the recording starts exactly on a beat", async () => {
            const {regions, validate, begin, loop} = await setup()
            loop(0, PPQN.Bar * 4)
            begin(1.0, PPQN.Bar)
            expect(regions().length).toBe(1)
            expect(regions()[0].duration).toBeGreaterThan(0)
            expect(() => validate()).not.toThrow()
        })

        it("opens the take after a loop wrap with a positive duration", async () => {
            const {regions, validate, begin, wrapAt, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, 10)
            wrapAt(1.0 + seconds(PPQN.Bar - 10), 0)
            expect(regions().length).toBe(2)
            expect(regions().map(region => region.duration > 0)).toEqual([true, true])
            expect(() => validate()).not.toThrow()
        })

        it("caps a take inside the loop at the loop end", async () => {
            const {regions, at, tick, begin, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, PPQN.Bar - PPQN.Quarter + 10)
            at(1.0 + seconds(PPQN.Quarter - 15))
            tick()
            expect(regions().length).toBe(1)
            expect(regions()[0].complete).toBe(PPQN.Bar)
        })
    })

    describe("take labels", () => {
        it("numbers a new recording's take after the takes already on the audio unit", async () => {
            const {regions, begin, stop, restart} = await setup()
            begin(1.0, PPQN.Bar)
            stop()
            restart()
            begin(5.0, 2 * PPQN.Bar)
            expect(regions().map(region => region.label)).toEqual(["Take 1", "Take 2"])
        })

        it("keeps counting through the loop wraps of a later recording", async () => {
            const {regions, begin, wrapAt, stop, restart, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, 10)
            stop()
            restart()
            begin(5.0, 10)
            wrapAt(5.0 + seconds(PPQN.Bar - 10), 0)
            expect(regions().map(region => region.label)).toEqual(["Take 1", "Take 2", "Take 3"])
        })

        it("opens a take for every wrap even when no position update runs in between", async () => {
            const {regions, begin, wrapAt, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, 0)
            // a hidden tab runs no animation frame: three wraps arrive back to back
            wrapAt(1.0 + seconds(PPQN.Bar), 0)
            wrapAt(1.0 + seconds(PPQN.Bar) * 2, 0)
            wrapAt(1.0 + seconds(PPQN.Bar) * 3, 0)
            expect(regions().map(region => region.label)).toEqual(["Take 1", "Take 2", "Take 3", "Take 4"])
            expect(regions().slice(0, 3).map(region => region.duration)).toEqual([PPQN.Bar, PPQN.Bar, PPQN.Bar])
        })
    })

    // A key is stamped when it is pressed. The note lands where the transport was heard at that moment,
    // independent of when the handler runs or when the playhead reached the main thread.
    describe("note timing", () => {
        const startAtBar = async (options?: { outputLatency?: number }) => {
            const context = await setup(options)
            context.at(1.0)
            context.begin(1.0, PPQN.Bar)
            return context
        }

        it("keeps the length a key was held when it is released between two playhead updates", async () => {
            const {notes, at, tick, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(1.0 + seconds(PPQN.Quarter))
            tick()
            at(1.0 + seconds(PPQN.Quarter + PPQN.Quarter / 2))
            noteOff(60)
            at(1.0 + seconds(PPQN.Quarter * 2))
            tick()
            expect(notes().map(({position, duration}) => [position, duration])).toEqual([[0, 1440]])
        })

        it("keeps the real length of a tap shorter than one playhead update", async () => {
            const {notes, at, tick, noteOn, noteOff} = await startAtBar()
            at(1.002)
            noteOn(60)
            at(1.025)
            noteOff(60)
            at(1.0333)
            tick()
            const tap = PPQN.secondsToPulses(0.023, 120)
            expect(Math.abs(notes()[0].duration - tap)).toBeLessThanOrEqual(0.5)
        })

        it("starts a key pressed between two playhead updates where it was pressed", async () => {
            const {notes, at, noteOn} = await startAtBar()
            at(1.0 + seconds(PPQN.SemiQuaver))
            noteOn(60)
            expect(notes()[0].position).toBe(PPQN.SemiQuaver)
        })

        it("keeps the length of a note held while no playhead update arrives", async () => {
            const {notes, at, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(1.25)
            noteOff(60)
            expect(notes()[0].duration).toBe(PPQN.Quarter / 2)
        })

        it("places a key heard past the loop end into the next take once the engine's wrap arrives", async () => {
            const {regions, notes, at, begin, wrapAt, noteOn, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, 10)
            const wrapTime = 1.0 + seconds(PPQN.Bar - 10)
            at(wrapTime + seconds(40))
            noteOn(60)
            expect(notes().length, "held until the wrap is known").toBe(0)
            wrapAt(wrapTime, 0)
            expect(regions().length).toBe(2)
            expect(regions()[1].optCollection.unwrap().events.asArray().map(({position}) => position)).toEqual([40])
        })

        it("keeps a key pressed after the loop end where it was pressed when the recording does not wrap", async () => {
            const {project, notes, at, begin, noteOn, loop} = await setup()
            project.engine.preferences.settings.recording.allowTakes = false
            loop(0, PPQN.Bar)
            begin(1.0, 10)
            at(1.0 + seconds(PPQN.Bar + 30))
            noteOn(60)
            expect(notes()[0].position).toBe(PPQN.Bar + 40)
        })

        it("grows the take over a key released or pressed after the last playhead update", async () => {
            const {regions, notes, at, tick, noteOn, noteOff} = await startAtBar()
            noteOn(60)
            at(1.0 + seconds(PPQN.Quarter - 20))
            tick()
            at(1.0 + seconds(PPQN.Quarter + 20))
            noteOff(60)
            noteOn(62)
            const [released, pressed] = notes()
            expect(released.position + released.duration).toBeLessThanOrEqual(regions()[0].duration)
            expect(pressed.position).toBeLessThan(regions()[0].duration)
        })

        it("starts a key where its MIDI event was stamped, not where a late handler sees it", async () => {
            const {notes, at, noteOnStamped} = await startAtBar()
            at(1.0 + seconds(PPQN.SemiQuaver))
            noteOnStamped(60, 1.0 + seconds(60))
            expect(notes()[0].position).toBe(60)
        })

        it("keeps the length held between the MIDI stamps of key-down and key-up", async () => {
            const {notes, at, noteOnStamped, noteOffStamped} = await startAtBar()
            at(1.0 + seconds(100))
            noteOnStamped(60, 1.0)
            at(1.0 + seconds(700))
            noteOffStamped(60, 1.0 + seconds(480))
            expect(notes().map(({position, duration}) => [position, duration])).toEqual([[0, 480]])
        })

        it("starts a key stamped before the last playhead update at its stamp", async () => {
            const {notes, at, tick, noteOnStamped} = await startAtBar()
            at(1.0 + seconds(240))
            tick()
            noteOnStamped(60, 1.0 + seconds(200))
            expect(notes()[0].position).toBe(200)
        })

        it("treats a stamp later than now as now", async () => {
            const {notes, at, noteOnStamped} = await startAtBar()
            at(1.0 + seconds(120))
            noteOnStamped(60, 1.0 + seconds(900))
            expect(notes()[0].position).toBe(120)
        })

        it("keeps the full length of a note held across a loop wrap", async () => {
            const {regions, notes, at, tick, begin, wrapAt, noteOn, noteOff, loop} = await setup()
            loop(0, PPQN.Bar)
            begin(1.0, 10)
            at(1.0 + seconds(PPQN.Bar - PPQN.Quarter + 50))
            tick()
            noteOn(60)
            wrapAt(1.0 + seconds(PPQN.Bar - 10), 0)
            at(1.0 + seconds(PPQN.Bar + 50))
            tick()
            at(1.0 + seconds(PPQN.Bar + 110))
            noteOff(60)
            expect(regions().length).toBe(2)
            expect(notes()[0].duration).toBe(PPQN.Quarter + 60)
        })

        it("records a key held from the count-in at the start of the take", async () => {
            const {notes, at, begin, noteOn} = await setup()
            at(0.9)
            noteOn(60)
            begin(1.0, PPQN.Bar)
            expect(notes().map(({position}) => position)).toEqual([0])
        })

        it("drops a key pressed and released during the count-in", async () => {
            const {notes, at, begin, noteOn, noteOff} = await setup()
            at(0.8)
            noteOn(60)
            at(0.9)
            noteOff(60)
            begin(1.0, PPQN.Bar)
            expect(notes().length).toBe(0)
        })
    })

    // The engine renders a quantum ahead of the speakers. A player hears beat N an output latency after the
    // engine rendered it, and presses the key with what they hear.
    describe("latency", () => {
        it("places a key where the transport was heard, an output latency before it was rendered", async () => {
            const {notes, at, begin, noteOn} = await setup({outputLatency: 0.020})
            begin(1.0, PPQN.Bar)
            // the speakers play the beat the engine rendered at 1.0 + one quarter
            at(1.0 + seconds(PPQN.Quarter) + 0.020)
            noteOn(60)
            expect(notes()[0].position).toBeCloseTo(PPQN.Quarter, 6)
        })

        it("places a key earlier by the plugin delay compensation the output carries", async () => {
            const {notes, at, begin, noteOn, compensate} = await setup({outputLatency: 0.020})
            compensate(0.010)
            begin(1.0, PPQN.Bar)
            at(1.0 + seconds(PPQN.Quarter) + 0.030)
            noteOn(60)
            expect(notes()[0].position).toBeCloseTo(PPQN.Quarter, 6)
        })
    })
})
