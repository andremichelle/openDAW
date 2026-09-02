import {describe, expect, it, vi} from "vitest"
import {Arrays, int, isDefined, MutableObservableValue, Option, UUID} from "@opendaw/lib-std"
import {InputLatencyCalibrationEntry, ProjectSkeleton} from "@opendaw/studio-adapters"
import {CaptureAudioBox} from "@opendaw/studio-boxes"
import type {ProjectEnv} from "../project/ProjectEnv"
import type {CaptureDevices} from "./CaptureDevices"
import type {RecordingWorklet} from "../RecordingWorklet"
import type {InputLatencyCalibration} from "./InputLatencyCalibration"

// A recording is placed from reports the audio thread sends while rendering, so a capture may only be
// prepared on a running context. These tests drive `prepareRecording` against contexts that are
// running, that resume on demand, and that stay suspended.

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

type FakeNode = {
    connect: (target: unknown) => void
    disconnect: (target?: unknown) => void
    connected: Array<unknown>
    disconnected: Array<unknown>
    gain: {value: number}
    pan: {value: number}
    channelCount: number
    channelCountMode: string
}

const createFakeNode = (): FakeNode => ({
    connect(target: unknown) {this.connected.push(target)},
    disconnect(target?: unknown) {this.disconnected.push(target)},
    connected: new Array<unknown>(),
    disconnected: new Array<unknown>(),
    gain: {value: 0},
    pan: {value: 0},
    channelCount: 2,
    channelCountMode: "explicit"
})

// The audio chain's silent sink is the only node the source is connected to that has its gain at zero:
// the record gain and the monitor gain both sit at unity while the chain is built.
const keepAliveSinkOf = (sourceNode: FakeNode): FakeNode => {
    const sinks = sourceNode.connected.filter(target => (target as FakeNode).gain?.value === 0) as Array<FakeNode>
    expect(sinks.length).toBe(1)
    return sinks[0]
}

const createFakeStream = (deviceId: string) => ({
    getAudioTracks: () => [{
        label: "Fake Input",
        getSettings: () => ({deviceId, channelCount: 2, latency: 0.005}),
        stop: () => {}
    }]
})

// `AudioDevices.requestStream` goes through `navigator.mediaDevices`; nothing else in these tests does.
const installFakeMediaDevices = (deviceId: string) => {
    Reflect.set(globalThis, "navigator", {
        mediaDevices: {
            getUserMedia: async () => createFakeStream(deviceId),
            enumerateDevices: async () => []
        }
    })
}

const createFakeRecordingWorklet = () => ({
    uuid: UUID.generate(),
    terminated: false,
    numberOfFrames: 0,
    firstQuantumTime: Option.None as Option<number>,
    set bpm(_: number) {},
    set sampleService(_: unknown) {},
    set onSaved(_: unknown) {},
    get data() {return Option.None},
    limit(_: number): void {},
    setFillLength(): void {},
    terminate(): void {this.terminated = true}
})

const setup = async ({state = "running", resumesTo = "running", deviceId = "fake-device"}:
                     {state?: AudioContextState, resumesTo?: AudioContextState, deviceId?: string} = {}) => {
    installFakeMediaDevices(deviceId)
    const {Project} = await import("../project/Project")
    const {CaptureAudio} = await import("./CaptureAudio")
    const destination = createFakeNode()
    const createdSourceNodes = new Array<FakeNode>()
    const audioContext = {
        state,
        currentTime: 100.0,
        outputLatency: 0.020,
        baseLatency: 0.005,
        sampleRate: 48_000,
        resumeCalls: 0,
        async resume(): Promise<void> {
            this.resumeCalls++
            this.state = resumesTo
        },
        destination,
        createGain: () => createFakeNode(),
        createStereoPanner: () => createFakeNode(),
        createMediaStreamSource: () => {
            const sourceNode = createFakeNode()
            createdSourceNodes.push(sourceNode)
            return sourceNode
        },
        // The calibration probe builds one buffer and one source node per burst.
        createBuffer: (channels: int, length: int, sampleRate: number) => ({
            numberOfChannels: channels, length, sampleRate, getChannelData: () => new Float32Array(length)
        }),
        createBufferSource: () => ({buffer: null, connect: () => {}, disconnect: () => {}, start: () => {}})
    }
    const preparedWorklets = new Array<ReturnType<typeof createFakeRecordingWorklet>>()
    const removedFromSampleManager = new Array<UUID.Bytes>()
    const env = {
        audioContext,
        audioWorklets: {
            createRecording: () => {
                const worklet = createFakeRecordingWorklet()
                preparedWorklets.push(worklet)
                return worklet as unknown as RecordingWorklet
            }
        },
        sampleManager: {
            record: () => {},
            remove: (uuid: UUID.Bytes) => {removedFromSampleManager.push(uuid)}
        },
        soundfontManager: undefined, sampleService: undefined, soundfontService: undefined
    } as unknown as ProjectEnv
    const skeleton = ProjectSkeleton.empty({createDefaultUser: true, createOutputMaximizer: false})
    const project = Project.fromSkeleton(env, skeleton)
    const {primaryAudioUnitBox} = skeleton.mandatoryBoxes
    const captureBox = project.editing.modify(() => {
        const box = CaptureAudioBox.create(project.boxGraph, UUID.generate())
        primaryAudioUnitBox.capture.refer(box) // the box is mandatory-referenced
        return box
    }).unwrap()
    const manager = {project} as unknown as CaptureDevices
    const capture = new CaptureAudio(manager, primaryAudioUnitBox, captureBox)
    // The record gain node is the one the audio chain holds; the monitor nodes come from the same factory.
    const recordGainNode = (): FakeNode => capture.outputNode.unwrap("no audio chain") as unknown as FakeNode
    return {
        capture, project, audioContext, preparedWorklets, removedFromSampleManager, recordGainNode,
        destination, createdSourceNodes
    }
}

// Arming requests the stream from the fake `getUserMedia`, which settles in microtasks, so the audio
// chain is there after flushing them.
const armAndAwaitChain = async (capture: Awaited<ReturnType<typeof setup>>["capture"]): Promise<void> => {
    capture.armed.setValue(true)
    for (let attempt = 0; attempt < 100 && capture.outputNode.isEmpty(); attempt++) {await Promise.resolve()}
    expect(capture.outputNode.nonEmpty()).toBe(true)
}

// The calibration factory: a capture whose transport state, device id and stored entries are given, and
// whose audio chain is either built (armed) or absent.
const setupCalibration = async ({isPlaying = false, isRecording = false, hasChain = true,
                                 deviceId = "mic-1", existingEntries = []}: {
    isPlaying?: boolean, isRecording?: boolean, hasChain?: boolean, deviceId?: string,
    existingEntries?: ReadonlyArray<InputLatencyCalibrationEntry>
} = {}) => {
    const context = await setup({deviceId})
    const {capture, project} = context
    const {engine} = project
    ;(engine.isPlaying as MutableObservableValue<boolean>).setValue(isPlaying)
    ;(engine.isRecording as MutableObservableValue<boolean>).setValue(isRecording)
    // jsdom keeps a localStorage, so preferences survive between tests; every case states its own entries.
    engine.preferences.settings.recording.inputLatencyCalibrations = [...existingEntries]
    if (hasChain) {
        await armAndAwaitChain(capture)
    }
    const storedEntries = (): ReadonlyArray<InputLatencyCalibrationEntry> =>
        engine.preferences.settings.recording.inputLatencyCalibrations
    return {...context, storedEntries}
}

/** Dependencies for {@link InputLatencyCalibration.measure} that report the given round trip on every burst. */
const fakeMeasureDeps = ({roundTrip, outputLatency, identified = 3, spread = 0.0}:
                         {roundTrip: number, outputLatency: number, identified?: int, spread?: number})
    : InputLatencyCalibration.Dependencies => ({
    analyze: async () => {
        const delays = Arrays.create(index => index < identified ? roundTrip : Number.NaN, 3)
        return {
            delays,
            ratiosDb: delays.map(delay => Number.isNaN(delay) ? Number.NEGATIVE_INFINITY : 30),
            roundTripSeconds: identified === 0 ? Number.NaN : roundTrip,
            spreadSeconds: spread,
            identifiedBursts: identified
        }
    },
    createCapture: () => ({
        connectFrom: () => {},
        stop: async () => ({startTime: 100.0, frames: new Float32Array(16)})
    }),
    // The routine reads the output latency only after the bursts played, so the wait installs it.
    waitUntil: async (context: BaseAudioContext) => {Reflect.set(context, "outputLatency", outputLatency)},
    now: () => 1_700_000_000_000
})

const entry = (deviceId: string, inputLatency: number): InputLatencyCalibrationEntry =>
    ({deviceId, inputLatency, outputLatencyAtCalibration: 0.020, spread: 0.0, measuredAt: 1})

describe("CaptureAudio", () => {
    describe("preparing a recording", () => {
        it("prepares on a running context", async () => {
            const {capture, audioContext, preparedWorklets} = await setup()
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(audioContext.resumeCalls).toBe(0)
            expect(preparedWorklets.length).toBe(1)
            expect(preparedWorklets[0].terminated).toBe(false)
        })

        it("resumes a suspended context and prepares once it is running", async () => {
            const {capture, audioContext, preparedWorklets} = await setup({state: "suspended"})
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(audioContext.resumeCalls).toBe(1)
            expect(audioContext.state).toBe("running")
            expect(preparedWorklets.length).toBe(1)
        })

        it("rejects when the context stays suspended, leaving no worklet prepared", async () => {
            const {capture, audioContext, preparedWorklets} =
                await setup({state: "suspended", resumesTo: "suspended"})
            await expect(capture.prepareRecording()).rejects.toBeDefined()
            expect(audioContext.resumeCalls).toBe(1)
            expect(preparedWorklets.length).toBe(0)
        })

        it("discards a worklet the previous prepare left behind", async () => {
            const {capture, preparedWorklets, removedFromSampleManager, recordGainNode} = await setup()
            await capture.prepareRecording()
            const orphan = preparedWorklets[0]
            const gainNode = recordGainNode()
            await capture.prepareRecording()
            expect(preparedWorklets.length).toBe(2)
            expect(orphan.terminated).toBe(true)
            expect(removedFromSampleManager).toEqual([orphan.uuid])
            expect(gainNode.disconnected).toContain(orphan)
            expect(preparedWorklets[1].terminated).toBe(false)
        })
    })

    describe("starting a recording", () => {
        it("discards the prepared worklet when the audio chain is gone", async () => {
            const {capture, preparedWorklets, removedFromSampleManager} = await setup()
            await capture.prepareRecording()
            const worklet = preparedWorklets[0]
            capture.armed.setValue(true)
            capture.armed.setValue(false) // tears the audio chain down behind the prepared worklet
            expect(capture.outputNode).toEqual(Option.None)
            expect(capture.startRecording()).toBeDefined()
            expect(worklet.terminated).toBe(true)
            expect(removedFromSampleManager).toEqual([worklet.uuid])
        })

        it("applies the calibration entry stored for the capture device", async () => {
            const {capture, project} = await setup()
            const {recording} = project.engine.preferences.settings
            recording.inputLatencyCalibrations = [{
                deviceId: "fake-device", // the id the fake track reports
                inputLatency: 0.0175,
                outputLatencyAtCalibration: 0.020,
                spread: 0.0001,
                measuredAt: 1
            }]
            await capture.prepareRecording()
            const reports = new Array<Record<string, unknown>>()
            const debug = vi.spyOn(console, "debug").mockImplementation((...args: ReadonlyArray<unknown>) => {
                if (args[0] === "[CaptureAudio] latency report") {
                    reports.push(args[1] as Record<string, unknown>)
                }
            })
            try {
                capture.startRecording().terminate()
            } finally {
                debug.mockRestore()
                recording.inputLatencyCalibrations = []
            }
            expect(reports.length).toBe(1)
            // The entry beats the track's own reported 0.005s and the Reported preference default.
            expect(reports[0].inputLatencyApplied).toBe(0.0175)
            expect(reports[0].inputLatencySource).toBe("calibrated")
        })
    })

    describe("keeping the input path pulled", () => {
        it("connects the source to a silent sink on the destination while the chain exists", async () => {
            const {capture, createdSourceNodes, destination} = await setup()
            await armAndAwaitChain(capture)
            expect(createdSourceNodes.length).toBe(1)
            expect(keepAliveSinkOf(createdSourceNodes[0]).connected).toContain(destination)
        })

        it("disconnects the silent sink when the chain is destroyed", async () => {
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            const sink = keepAliveSinkOf(createdSourceNodes[0])
            capture.armed.setValue(false)
            expect(capture.outputNode).toEqual(Option.None)
            expect(sink.disconnected).toEqual([undefined]) // a bare disconnect drops every edge
        })

        it("leaves the silent sink in place while monitoring is switched on and off", async () => {
            const {capture, createdSourceNodes} = await setup()
            await armAndAwaitChain(capture)
            const sourceNode = createdSourceNodes[0]
            const sink = keepAliveSinkOf(sourceNode)
            capture.monitoringMode = "direct"
            capture.monitoringMode = "off"
            expect(sink.disconnected).toEqual([])
            expect(sourceNode.disconnected).not.toContain(sink)
            expect(sourceNode.disconnected).not.toContain(undefined)
            expect(sourceNode.connected.filter(target => target === sink).length).toBe(1)
        })

        it("prepares a recording with the sink on the chain the recording uses", async () => {
            const {capture, createdSourceNodes, destination, preparedWorklets} = await setup()
            await armAndAwaitChain(capture)
            await expect(capture.prepareRecording()).resolves.toBeUndefined()
            expect(preparedWorklets.length).toBe(1)
            // The capture box carries no device id, so the requested id never matches the one the fake
            // stream reports and `prepareRecording` rebuilds the chain: the sink under test is the newest.
            const newestSourceNode = createdSourceNodes[createdSourceNodes.length - 1]
            expect(keepAliveSinkOf(newestSourceNode).connected).toContain(destination)
        })
    })

    describe("calibrating the input latency", () => {
        it("refuses while the transport runs, without touching audio", async () => {
            const {capture} = await setupCalibration({isPlaying: true})
            const result = await capture.calibrateInputLatency({},
                {analyze: async () => {throw new Error("must not run")}})
            expect(result.verdict).toBe("transport-running")
        })

        it("refuses while the transport records", async () => {
            const {capture} = await setupCalibration({isRecording: true})
            const result = await capture.calibrateInputLatency({},
                {analyze: async () => {throw new Error("must not run")}})
            expect(result.verdict).toBe("transport-running")
        })

        it("reports no-stream when the capture has no audio chain", async () => {
            const {capture} = await setupCalibration({hasChain: false})
            const result = await capture.calibrateInputLatency({})
            expect(result.verdict).toBe("no-stream")
        })

        it("stores one entry per device id, replacing an older one", async () => {
            const {capture, storedEntries} = await setupCalibration({
                deviceId: "mic-1",
                existingEntries: [entry("mic-1", 0.5), entry("mic-2", 0.011)]
            })
            try {
                const result = await capture.calibrateInputLatency({apply: true},
                    fakeMeasureDeps({roundTrip: 0.0312, outputLatency: 0.023}))
                expect(result.verdict).toBe("ok")
                const entries = storedEntries()
                expect(entries.map(stored => stored.deviceId).sort()).toEqual(["mic-1", "mic-2"])
                expect(entries.find(stored => stored.deviceId === "mic-1")?.inputLatency).toBeCloseTo(0.0082, 6)
                expect(entries.find(stored => stored.deviceId === "mic-2")?.inputLatency).toBe(0.011)
            } finally {
                capture.clearInputLatencyCalibration()
            }
        })

        it("stores nothing without apply", async () => {
            const {capture, storedEntries} = await setupCalibration({deviceId: "mic-1"})
            const result = await capture.calibrateInputLatency({},
                fakeMeasureDeps({roundTrip: 0.0312, outputLatency: 0.023}))
            expect(result.verdict).toBe("ok")
            expect(storedEntries()).toEqual([])
        })

        it("never stores a no-signal result, even with apply", async () => {
            const {capture, storedEntries} = await setupCalibration({deviceId: "mic-1"})
            const result = await capture.calibrateInputLatency({apply: true},
                fakeMeasureDeps({roundTrip: Number.NaN, outputLatency: 0.023, identified: 0}))
            expect(result.verdict).toBe("no-signal")
            expect(storedEntries()).toEqual([])
        })

        it("never stores a non-finite measurement, even on a passing verdict", async () => {
            const {capture, storedEntries} = await setupCalibration({deviceId: "mic-1"})
            // Every burst is identified and the spread is inside the bound, so the verdict passes, but the
            // delays themselves are not numbers: an entry built from them would fail the schema on reload.
            const result = await capture.calibrateInputLatency({apply: true},
                fakeMeasureDeps({roundTrip: Number.NaN, outputLatency: 0.023, identified: 3}))
            expect(result.verdict).toBe("ok")
            expect(Number.isNaN(result.inputLatencySeconds)).toBe(true)
            expect(storedEntries()).toEqual([])
        })

        it("stores a negative spread as zero", async () => {
            const {capture, storedEntries} = await setupCalibration({deviceId: "mic-1"})
            try {
                // The schema requires a non-negative spread; an analysis reporting less costs the user
                // the whole recording section on the next load, so the stored entry is clamped.
                const result = await capture.calibrateInputLatency({apply: true},
                    fakeMeasureDeps({roundTrip: 0.0312, outputLatency: 0.023, spread: -0.001}))
                expect(result.verdict).toBe("ok")
                expect(storedEntries()[0].spread).toBe(0)
            } finally {
                capture.clearInputLatencyCalibration()
            }
        })

        it("clears only this device's entry", async () => {
            const {capture, project, storedEntries} = await setupCalibration({
                deviceId: "mic-1",
                existingEntries: [entry("mic-1", 0.010), entry("mic-2", 0.011)]
            })
            try {
                capture.clearInputLatencyCalibration()
                expect(storedEntries().map(stored => stored.deviceId)).toEqual(["mic-2"])
            } finally {
                project.engine.preferences.settings.recording.inputLatencyCalibrations = []
            }
        })
    })
})
