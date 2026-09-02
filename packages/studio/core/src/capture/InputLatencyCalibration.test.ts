import {describe, expect, test, vi} from "vitest"
import {int, isDefined, Optional} from "@opendaw/lib-std"
import {LatencyCalibrationAnalysis, LatencyProbe} from "@opendaw/lib-dsp"
import type {InputLatencyCalibration as Calibration} from "./InputLatencyCalibration"

// The module reaches LatencyCaptureNode, which extends AudioWorkletNode; jsdom has no Web Audio, and
// the injected dependencies mean no capture node is ever constructed here.
if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

const {InputLatencyCalibration} = await import("./InputLatencyCalibration")
const {Workers} = await import("../Workers")

interface FakeGain {disconnected: boolean}

/** The mutable slice of AudioContext the routine touches, plus what it built and scheduled. */
interface FakeContext {
    state: AudioContextState
    sampleRate: number
    currentTime: number
    outputLatency: Optional<number>
    resume(): Promise<void>
    createBuffer(channels: int, length: int, sampleRate: number): AudioBuffer
    createBufferSource(): AudioBufferSourceNode
    createGain(): GainNode
    started: Array<number>
    gains: Array<FakeGain>
    bufferLengths: Array<int>
}

const makeContext = (state: AudioContextState, outputLatency: Optional<number>,
                     resumeTo: AudioContextState = state): FakeContext => {
    const context: FakeContext = {
        state, sampleRate: 48000, currentTime: 100.0,
        outputLatency,
        resume: async () => {context.state = resumeTo},
        createBuffer: (channels: int, length: int, sampleRate: number) => {
            context.bufferLengths.push(length)
            return {
                numberOfChannels: channels, length, sampleRate, getChannelData: () => new Float32Array(length)
            } as unknown as AudioBuffer
        },
        createBufferSource: () => ({
            buffer: null, connect() {}, disconnect() {}, start(time: number) {context.started.push(time)}
        } as unknown as AudioBufferSourceNode),
        createGain: () => {
            const gain: FakeGain = {disconnected: false}
            context.gains.push(gain)
            return {
                gain: {value: 1}, connect() {}, disconnect() {gain.disconnected = true}
            } as unknown as GainNode
        },
        started: [],
        gains: [],
        bufferLengths: []
    }
    return context
}
interface FakeCapture extends Calibration.Capture {stopped: boolean}
const makeCapture = (): FakeCapture => {
    const capture: FakeCapture = {
        stopped: false,
        connectFrom() {},
        stop: async () => {
            capture.stopped = true
            return {startTime: 100.05, frames: new Float32Array(16)}
        }
    }
    return capture
}
const fakeNode = (): AudioNode => ({connect() {}, disconnect() {}} as unknown as AudioNode)
const measure = (context: FakeContext, options: Calibration.Options,
                 dependencies: Partial<Calibration.Dependencies>) =>
    InputLatencyCalibration.measure(context as unknown as AudioContext, fakeNode(), fakeNode(), options, dependencies)
const analysisOf = (delays: Array<number>, ratios: Array<number>) => async (): Promise<LatencyCalibrationAnalysis> => {
    const identified = delays.filter(delay => !Number.isNaN(delay))
    const roundTripSeconds = identified.length === 0
        ? Number.NaN : identified.sort((left, right) => left - right)[identified.length >> 1]
    const spreadSeconds = identified.length <= 1 ? 0 : Math.max(...identified.map(delay => Math.abs(delay - roundTripSeconds)))
    return {delays, ratiosDb: ratios, roundTripSeconds, spreadSeconds, identifiedBursts: identified.length}
}
const deps = (analyze: Calibration.Dependencies["analyze"],
              latencyDuringRun?: (context: FakeContext) => void,
              capture: FakeCapture = makeCapture()): Calibration.Dependencies => ({
    analyze,
    createCapture: () => capture,
    waitUntil: async (context, time) => {
        const fake = context as unknown as FakeContext
        fake.currentTime = time
        latencyDuringRun?.(fake)
    },
    now: () => 1700000000000
})

describe("InputLatencyCalibration.measure", () => {
    test("ok: subtracts the output latency read after the bursts played", async () => {
        const context = makeContext("running", 0) // 0 until output has run
        const result = await measure(context, {},
            deps(analysisOf([0.0312, 0.0311, 0.0312], [30, 31, 29]), fake => {fake.outputLatency = 0.023}))
        expect(result.verdict).toBe("ok")
        expect(result.outputLatencyReported).toBe(true)
        expect(result.outputLatencySeconds).toBe(0.023)
        expect(result.roundTripSeconds).toBeCloseTo(0.0312, 6)
        expect(result.inputLatencySeconds).toBeCloseTo(0.0082, 6)
        expect(result.identifiedBursts).toBe(3)
        expect(result.scheduledBursts).toBe(3)
        expect(result.correlationRatioDb).toBe(29)
        expect(result.measuredAt).toBe(1700000000000)
        expect(result.probe).toBe("mls-15")
    })
    test("an injected probe is the burst that plays and the probe the result names", async () => {
        const context = makeContext("running", 0.02)
        const renderedAt: Array<number> = []
        const probe: LatencyProbe = {
            name: "test-burst",
            render: sampleRate => {
                renderedAt.push(sampleRate)
                return new Float32Array(512)
            }
        }
        const result = await measure(context, {probe}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(result.probe).toBe("test-burst")
        expect(renderedAt).toEqual([48000]) // rendered once, at the context's rate
        expect(context.bufferLengths).toEqual([512])
        const spacing = 512 / 48000 + InputLatencyCalibration.BurstTailSeconds
        expect(context.started[1] - context.started[0]).toBeCloseTo(spacing, 6)
    })
    test("schedules the bursts at increasing context times starting after the lead-in", async () => {
        const context = makeContext("running", 0.02)
        await measure(context, {}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(context.started.length).toBe(3)
        expect(context.started[0]).toBeGreaterThanOrEqual(100.0 + InputLatencyCalibration.LeadInSeconds)
        const spacing = (Math.pow(2, InputLatencyCalibration.MlsOrder) - 1) / 48000 + InputLatencyCalibration.BurstTailSeconds
        expect(context.started[1] - context.started[0]).toBeCloseTo(spacing, 6)
        expect(context.bufferLengths).toEqual([Math.pow(2, InputLatencyCalibration.MlsOrder) - 1])
    })
    test("unreported output latency: input part equals the round trip and is flagged", async () => {
        const context = makeContext("running", undefined)
        const result = await measure(context, {}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(result.outputLatencyReported).toBe(false)
        expect(result.outputLatencySeconds).toBe(0)
        expect(result.inputLatencySeconds).toBeCloseTo(0.03, 6)
        expect(result.verdict).toBe("ok")
    })
    test("noisy when the spread exceeds the bound or a burst is missing", async () => {
        const context = makeContext("running", 0.02)
        const wide = await measure(context, {}, deps(analysisOf([0.030, 0.030, 0.033], [30, 30, 30])))
        expect(wide.verdict).toBe("noisy")
        expect(wide.spreadSeconds).toBeCloseTo(0.003, 6)
        // A rejected burst carries -Infinity, the ratio analyzeBursts really emits for one; the reported
        // ratio is the minimum over the identified bursts only, so the rejected one must not reach it.
        const missing = await measure(context, {},
            deps(analysisOf([0.030, Number.NaN, 0.030], [30, Number.NEGATIVE_INFINITY, 30])))
        expect(missing.verdict).toBe("noisy")
        expect(missing.identifiedBursts).toBe(2)
        expect(missing.correlationRatioDb).toBe(30)
    })
    test("no-signal when nothing is identified", async () => {
        const context = makeContext("running", 0.02)
        const result = await measure(context, {}, deps(analysisOf([Number.NaN, Number.NaN, Number.NaN], [3, 2, 4])))
        expect(result.verdict).toBe("no-signal")
        expect(Number.isNaN(result.roundTripSeconds)).toBe(true)
    })
    test("context-not-running when resume does not bring the context up; no bursts scheduled", async () => {
        const context = makeContext("suspended", 0.02, "suspended")
        const result = await measure(context, {}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(result.verdict).toBe("context-not-running")
        expect(context.started.length).toBe(0)
    })
    test("a suspended context that resumes proceeds", async () => {
        const context = makeContext("suspended", 0.02, "running")
        const result = await measure(context, {}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(result.verdict).toBe("ok")
    })
    test("respects burstCount and gainDb options", async () => {
        const context = makeContext("running", 0.02)
        const result = await measure(context, {burstCount: 2, gainDb: -20}, deps(analysisOf([0.03, 0.03], [30, 30])))
        expect(result.scheduledBursts).toBe(2)
        expect(context.started.length).toBe(2)
    })
    test("throws before building anything when the SDK worker is not installed", async () => {
        expect(Workers.messenger.isEmpty()).toBe(true)
        const context = makeContext("running", 0.02)
        await expect(measure(context, {}, {})).rejects.toThrow("Workers are not installed")
        expect(context.started.length).toBe(0)
        expect(context.gains.length).toBe(0)
    })
    test("an injected analyze is not gated on the worker", async () => {
        expect(Workers.messenger.isEmpty()).toBe(true)
        const context = makeContext("running", 0.02)
        const result = await measure(context, {}, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])))
        expect(result.verdict).toBe("ok")
    })
    test("a stalled clock stops the capture, disconnects the output and reports context-not-running", async () => {
        const context = makeContext("running", 0.02)
        const capture = makeCapture()
        const result = await measure(context, {}, {
            ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]), undefined, capture),
            waitUntil: async (_context, time) => {throw new InputLatencyCalibration.ClockStalled(time)}
        })
        expect(result.verdict).toBe("context-not-running")
        expect(capture.stopped).toBe(true)
        expect(context.gains[0].disconnected).toBe(true)
    })
    test("the default clock wait gives up once its wall-clock deadline passes", async () => {
        vi.useFakeTimers()
        try {
            const context = makeContext("running", 0.02) // currentTime never advances
            const capture = makeCapture()
            const pending = measure(context, {}, {
                analyze: analysisOf([0.03, 0.03, 0.03], [30, 30, 30]),
                createCapture: () => capture,
                now: () => 1700000000000
            })
            await vi.advanceTimersByTimeAsync(60_000)
            const result = await pending
            expect(result.verdict).toBe("context-not-running")
            expect(capture.stopped).toBe(true)
            expect(context.gains[0].disconnected).toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })
    test("a rejecting analyze leaves nothing connected", async () => {
        const context = makeContext("running", 0.02)
        const capture = makeCapture()
        const failing = async () => {throw new Error("worker died")}
        await expect(measure(context, {}, {...deps(failing, undefined, capture)})).rejects.toThrow("worker died")
        expect(capture.stopped).toBe(true)
        expect(context.gains[0].disconnected).toBe(true)
    })
})
