import {afterEach, describe, expect, it, vi} from "vitest"
import {
    DefaultObservableValue,
    Exec,
    isDefined,
    MutableObservableOption,
    Notifier,
    Observer,
    Option,
    Procedure,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {MidiData} from "@opendaw/lib-midi"
import {CaptureMidiBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TransportAnchor} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {EngineWorklet} from "../EngineWorklet"
import type {RecordingStart} from "../Engine"
import type {ContextClock, MidiInputMessage, MidiInputPort} from "../io"

// The retroactive capture keeps what an armed MIDI track played while nothing recorded. Every key is stamped
// with the context time that was audible when it was pressed. While the transport runs, the notes are placed
// on the transport the engine reported (start, wraps), while it stands still, in seconds at the tempo.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

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
    noteSignal: () => {},
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

const createFakeInput = () => {
    const messages = new Notifier<MidiInputMessage>()
    const input: MidiInputPort = {
        subscribe: (_deviceId: Option<string>, observer: Procedure<MidiInputMessage>) => messages.subscribe(observer),
        subscribeDevicesChanged: (_observer: Exec) => Terminable.Empty
    }
    return {input, messages}
}

const setup = async () => {
    const {Project} = await import("../project/Project")
    const {CaptureMidi} = await import("./CaptureMidi")
    const audioContext = {currentTime: 0, sampleRate: 48_000, outputLatency: 0}
    const clock = {now: 0}
    vi.spyOn(performance, "now").mockImplementation(() => clock.now)
    const contextClock: ContextClock = {audibleTimeAt: (performanceTime: number) => performanceTime / 1000.0}
    const env = {audioContext} as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const worklet = createFakeWorklet()
    project.engine.setWorklet(worklet as unknown as EngineWorklet)
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    const captureBox = project.editing.modify(() => {
        const box = CaptureMidiBox.create(project.boxGraph, UUID.generate())
        primaryAudioUnitBox.capture.refer(box)
        return box
    }).unwrap("CaptureMidiBox")
    const {input, messages} = createFakeInput()
    const capture = new CaptureMidi(project.captureDevices, primaryAudioUnitBox, captureBox, input, contextClock)
    capture.armed.setValue(true)
    await Promise.resolve()
    const at = (seconds: number) => {clock.now = seconds * 1000.0}
    const key = (pitch: number, from: number, to: number) => {
        at(from)
        messages.notify({data: MidiData.noteOn(0, pitch, 127), timeStamp: clock.now})
        at(to)
        messages.notify({data: MidiData.noteOff(0, pitch), timeStamp: clock.now})
    }
    const play = (contextTime: number, position: ppqn) => {
        worklet.anchors.notify([{kind: "start", contextTime, position, recording: false}])
        worklet.isPlaying.setValue(true)
    }
    const jump = (contextTime: number, position: ppqn) =>
        worklet.anchors.notify([{kind: "jump", contextTime, position, recording: false}])
    const loop = (from: ppqn, to: ppqn) => project.editing.modify(() => {
        const {loopArea} = project.timelineBox
        loopArea.from.setValue(from)
        loopArea.to.setValue(to)
        loopArea.enabled.setValue(true)
    })
    const resolve = () => capture.resolveCapture().unwrap("nothing captured")
    return {project, worklet, audioContext, capture, at, key, play, jump, loop, resolve}
}

const seconds = (pulses: ppqn) => PPQN.pulsesToSeconds(pulses, 120)
const shape = ({notes}: { notes: ReadonlyArray<{ position: ppqn, duration: ppqn }> }) =>
    notes.map(({position, duration}) => [position, duration].map(value => Math.round(value)))

describe("CaptureMidi", () => {
    afterEach(() => {vi.restoreAllMocks()})

    it("captures in seconds at the tempo while the transport stands still", async () => {
        const {key, resolve, at} = await setup()
        key(60, 10.0, 10.25)
        key(62, 10.5, 10.75)
        at(11.0)
        const result = resolve()
        expect(result.mode).toBe("stopped")
        expect(shape(result)).toEqual([[0, PPQN.Quarter / 2], [PPQN.Quarter, PPQN.Quarter / 2]])
    })

    it("places the notes on the transport the engine reported while it runs", async () => {
        const {key, play, resolve, at} = await setup()
        play(1.0, PPQN.Bar)
        key(60, 1.0 + seconds(PPQN.Quarter), 1.0 + seconds(PPQN.Quarter * 2))
        key(62, 1.0 + seconds(PPQN.Quarter * 3), 1.0 + seconds(PPQN.Quarter * 3 + 100))
        at(2.0)
        const result = resolve()
        expect(result.mode).toBe("playing")
        expect(Math.round(result.origin)).toBe(PPQN.Bar + PPQN.Quarter)
        expect(shape(result)).toEqual([[0, PPQN.Quarter], [PPQN.Quarter * 2, 100]])
    })

    it("keeps counting across a loop wrap, so a phrase over the loop end stays in order", async () => {
        const {key, play, jump, loop, resolve, at} = await setup()
        loop(0, PPQN.Bar)
        play(1.0, 0)
        jump(1.0 + seconds(PPQN.Bar), 0)
        key(60, 1.0 + seconds(PPQN.Bar - PPQN.Quarter), 1.0 + seconds(PPQN.Bar - PPQN.Quarter / 2))
        key(62, 1.0 + seconds(PPQN.Bar + PPQN.Quarter / 2), 1.0 + seconds(PPQN.Bar + PPQN.Quarter))
        at(4.0)
        const result = resolve()
        expect(Math.round(result.origin)).toBe(PPQN.Bar - PPQN.Quarter)
        expect(shape(result)).toEqual([[0, PPQN.Quarter / 2], [PPQN.Quarter * 3 / 2, PPQN.Quarter / 2]])
    })

    it("begins at the render clock when armed while the transport already ran", async () => {
        const {worklet, audioContext, key, resolve, at} = await setup()
        audioContext.currentTime = 5.0
        worklet.position.setValue(PPQN.Bar * 2)
        worklet.isPlaying.setValue(true)
        key(60, 5.0 + seconds(PPQN.Quarter), 5.0 + seconds(PPQN.Quarter * 2))
        at(6.0)
        expect(Math.round(resolve().origin)).toBe(PPQN.Bar * 2 + PPQN.Quarter)
    })

    it("counts the notes the capture holds", async () => {
        const {capture, key} = await setup()
        key(60, 1.0, 1.1)
        key(62, 1.2, 1.3)
        expect(capture.captureNoteOnCount.getValue()).toBe(2)
        capture.resetCapture()
        expect(capture.captureNoteOnCount.getValue()).toBe(0)
        expect(capture.resolveCapture().isEmpty()).toBe(true)
    })
})
