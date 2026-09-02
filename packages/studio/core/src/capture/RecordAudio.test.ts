import {describe, expect, it} from "vitest"
import {DefaultObservableValue, isDefined, MutableObservableOption, Option, Terminable, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {AudioRegionBoxAdapter, AudioUnitBoxAdapter, ProjectSkeleton} from "@opendaw/studio-adapters"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {EngineWorklet} from "../EngineWorklet"
import type {RecordingWorklet} from "../RecordingWorklet"
import type {Capture} from "./Capture"

// An audio take is placed from two audio-thread reports: the engine's `recordingStart` (context time and
// playhead position at the end of the quantum recording began in) and the recording processor's
// `firstQuantumTime` (context time of the buffer's first frame). The tests drive both by hand.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const SAMPLE_RATE = 48_000

const sampleManager = () => ({
    getOrCreate: (uuid: UUID.Bytes) => ({
        get data() {return Option.None}, get peaks() {return Option.None}, get uuid() {return uuid},
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
    recordingStart: new MutableObservableOption<{contextTime: number, position: ppqn}>(),
    preferences: {update: () => {}, subscribeAll: () => Terminable.Empty}
})

const createFakeRecordingWorklet = () => ({
    uuid: UUID.generate(),
    firstQuantumTime: Option.None as Option<number>,
    numberOfFrames: 0,
    limits: new Array<number>(),
    limit(count: number): void {this.limits.push(count)},
    terminate(): void {},
    setFillLength(): void {},
    set onSaved(_: unknown) {},
    get data() {return Option.None}
})

const setup = async () => {
    const {Project} = await import("../project/Project")
    const {RecordAudio} = await import("./RecordAudio")
    const audioContext = {currentTime: 0, sampleRate: SAMPLE_RATE}
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
    project.editing.modify(() => project.timelineBox.loopArea.enabled.setValue(false))
    const recordingWorklet = createFakeRecordingWorklet()
    const capture = {
        audioUnitBox: primaryAudioUnitBox,
        addRecordedRegion: () => {}
    } as unknown as Capture
    const recorder = RecordAudio.start({
        recordingWorklet: recordingWorklet as unknown as RecordingWorklet,
        sourceNode: {disconnect: () => {}} as unknown as AudioNode,
        sampleManager: project.env.sampleManager,
        project,
        capture,
        outputLatency: 0.020,
        inputLatency: 0.010
    })
    const regions = (): ReadonlyArray<AudioRegionBoxAdapter> => audioUnit.tracks.values()
        .flatMap(track => track.regions.collection.asArray())
        .filter(region => region.isAudioRegion())
    const tick = (position: ppqn) => worklet.position.setValue(position)
    const record = () => worklet.isRecording.setValue(true)
    const startAt = (contextTime: number, position: ppqn) => worklet.recordingStart.wrap({contextTime, position})
    const firstQuantumAt = (contextTime: number) => recordingWorklet.firstQuantumTime = Option.wrap(contextTime)
    const deliver = (seconds: number) => recordingWorklet.numberOfFrames = Math.round(seconds * SAMPLE_RATE)
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
    return {project, audioContext, recordingWorklet, regions, tick, record, startAt, firstQuantumAt, deliver, stop, loop}
}

describe("RecordAudio", () => {
    describe("placing the first take", () => {
        it("anchors the take on the engine's recording start and the buffer's first frame", async () => {
            const {regions, tick, record, startAt, firstQuantumAt, deliver} = await setup()
            firstQuantumAt(1.0)
            startAt(1.5, PPQN.Bar)
            deliver(0.6)
            record()
            tick(PPQN.Bar + 40) // the main thread observes the transport further along
            expect(regions().length).toBe(1)
            const region = regions()[0]
            expect(region.position).toBe(PPQN.Bar)
            // half a second of buffer precedes the start, plus outputLatency and inputLatency
            expect(region.box.waveformOffset.getValue()).toBeCloseTo(0.5 + 0.020 + 0.010, 6)
        })

        it("moves a fractional start position into the offset", async () => {
            const {regions, tick, record, startAt, firstQuantumAt, deliver} = await setup()
            firstQuantumAt(1.0)
            startAt(1.5, PPQN.Bar + 0.5)
            deliver(0.6)
            record()
            tick(PPQN.Bar + 40)
            const region = regions()[0]
            expect(region.position).toBe(PPQN.Bar)
            expect(region.box.waveformOffset.getValue())
                .toBeCloseTo(0.530 - PPQN.pulsesToSeconds(0.5, 120), 6)
        })

        it("begins the take where the captured audio begins when the buffer's first frame postdates the start",
            async () => {
                const {regions, tick, record, startAt, firstQuantumAt, deliver} = await setup()
                firstQuantumAt(2.03) // 0.5 s after the start, net of the two latency terms
                startAt(1.5, PPQN.Bar)
                deliver(0.1)
                record()
                tick(PPQN.Bar + 40)
                const region = regions()[0]
                expect(region.position).toBe(PPQN.Bar + PPQN.secondsToPulses(0.5, 120))
                expect(region.box.waveformOffset.getValue()).toBeCloseTo(0.0, 6)
            })

        it("rounds a covered start that falls between pulses up to the next one and keeps the rest in the offset",
            async () => {
                const {regions, tick, record, startAt, firstQuantumAt, deliver} = await setup()
                // the first frame is 960.5 pulses late: the take cannot begin on the half pulse
                firstQuantumAt(1.5 + 0.020 + 0.010 + PPQN.pulsesToSeconds(960.5, 120))
                startAt(1.5, PPQN.Bar)
                deliver(0.1)
                record()
                tick(PPQN.Bar + 1000)
                const region = regions()[0]
                expect(region.position).toBe(PPQN.Bar + 961)
                // the audio covers the half pulse before the rounded position
                expect(region.box.waveformOffset.getValue()).toBeCloseTo(PPQN.pulsesToSeconds(0.5, 120), 8)
                expect(region.box.waveformOffset.getValue()).toBeGreaterThan(0)
            })

        it("waits for both anchors before placing the take", async () => {
            const {regions, tick, record, startAt, firstQuantumAt, deliver} = await setup()
            firstQuantumAt(1.0)
            deliver(0.6)
            record()
            tick(PPQN.Bar + 40)
            expect(regions().length).toBe(0)
            startAt(1.5, PPQN.Bar)
            tick(PPQN.Bar + 80)
            expect(regions().length).toBe(1)
            expect(regions()[0].position).toBe(PPQN.Bar)
        })

        it("falls back to the main-thread observations once the wait for the anchors expires", async () => {
            const {audioContext, regions, tick, record, deliver} = await setup()
            audioContext.currentTime = 10.0
            deliver(0.6)
            record()
            tick(PPQN.Bar + 40)
            expect(regions().length).toBe(0)
            audioContext.currentTime = 10.3
            tick(PPQN.Bar + 80)
            expect(regions().length).toBe(1)
            const region = regions()[0]
            expect(region.position).toBe(PPQN.Bar + 80)
            expect(region.box.waveformOffset.getValue()).toBeCloseTo(0.6 + 0.020 + 0.010, 6)
        })
    })

    describe("stopping", () => {
        it("runs the take to the last frame the ring delivered and keeps every frame", async () => {
            const {regions, recordingWorklet, tick, record, startAt, firstQuantumAt, deliver, stop} = await setup()
            firstQuantumAt(1.0)
            startAt(1.5, 0)
            deliver(0.6)
            record()
            tick(40)
            deliver(4.53) // the live duration becomes 4.53 - 0.53 = 4.0 s
            tick(PPQN.Bar * 2)
            deliver(4.56) // chunks keep arriving between the last position tick and the stop
            stop()
            expect(regions().length).toBe(1)
            expect(regions()[0].box.duration.getValue()).toBeCloseTo(4.56 - 0.53, 5)
            expect(recordingWorklet.limits).toEqual([Math.round(4.56 * SAMPLE_RATE)])
        })

        it("aborts a recording whose only take never grew past zero and removes its file box", async () => {
            const {project, regions, recordingWorklet, tick, record, startAt, firstQuantumAt, deliver, stop} =
                await setup()
            firstQuantumAt(1.0)
            startAt(1.5, 0)
            deliver(0.3) // less than the 0.53 s the take's window begins at
            record()
            tick(40)
            expect(regions().length).toBe(1)
            expect(project.boxGraph.findBox(recordingWorklet.uuid).nonEmpty()).toBe(true)
            stop()
            expect(regions().length).toBe(0)
            expect(recordingWorklet.limits).toEqual([])
            expect(project.boxGraph.findBox(recordingWorklet.uuid).isEmpty()).toBe(true)
        })

        it("finalizes the earlier takes when the stop drops a take that never grew past zero", async () => {
            const {regions, recordingWorklet, tick, record, startAt, firstQuantumAt, deliver, stop, loop} =
                await setup()
            loop(0, PPQN.Bar) // 2 s at 120 bpm
            firstQuantumAt(1.0)
            startAt(1.5, 0)
            deliver(0.6)
            record()
            tick(40)
            deliver(2.4)
            tick(PPQN.Bar - 40)
            // the wrap closes take 1 at the loop end and opens take 2, whose window starts 0.53 + 2 s
            // into the buffer, ahead of what the ring has delivered so far
            tick(20)
            expect(regions().length).toBe(2)
            expect(regions().map(region => region.box.duration.getValue() > 0)).toEqual([true, false])
            stop()
            expect(regions().length).toBe(1)
            expect(recordingWorklet.limits).toEqual([recordingWorklet.numberOfFrames])
        })
    })
})
