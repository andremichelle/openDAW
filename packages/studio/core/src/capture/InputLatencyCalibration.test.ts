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
interface FakeCapture extends Calibration.Capture {
    stopped: boolean
    /** The context time the routine asked for this capture at, so the anchors' instants are testable. */
    createdAt: number
    connectedTo: Optional<AudioNode>
}
const makeCapture = (startTime: number = 100.05): FakeCapture => {
    const capture: FakeCapture = {
        stopped: false,
        createdAt: Number.NaN,
        connectedTo: undefined,
        connectFrom(source: AudioNode) {capture.connectedTo = source},
        stop: async () => {
            capture.stopped = true
            return {startTime, frames: new Float32Array(16)}
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
/** Hands out one analysis per analyze call, in call order, repeating the last one. */
const analysesOf = (...analyses: ReadonlyArray<() => Promise<LatencyCalibrationAnalysis>>)
    : Calibration.Dependencies["analyze"] => {
    let call = 0
    return async () => analyses[Math.min(call++, analyses.length - 1)]()
}
const deps = (analyze: Calibration.Dependencies["analyze"],
              latencyDuringRun?: (context: FakeContext) => void,
              captures: ReadonlyArray<FakeCapture> = [makeCapture()]): Calibration.Dependencies => {
    let created = 0
    return {
        analyze,
        // Fewer fakes than anchors hands the last one out again, so a test that cares about only one
        // capture passes only that one.
        createCapture: context => {
            const capture = captures[Math.min(created++, captures.length - 1)]
            capture.createdAt = (context as unknown as FakeContext).currentTime
            return capture
        },
        waitUntil: async (context, time) => {
            const fake = context as unknown as FakeContext
            fake.currentTime = time
            latencyDuringRun?.(fake)
        },
        now: () => 1700000000000
    }
}

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
    describe("invalid options", () => {
        // Each of these leaves the last burst's end time as NaN, which the default clock wait can
        // neither reach nor time out on: it would hang with the first anchor open and the probe
        // already audible. They are caller mistakes, so they are refused before anything is built.
        const rejects = async (options: Calibration.Options, message: string) => {
            const context = makeContext("running", 0.02)
            await expect(measure(context, options, deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]))))
                .rejects.toThrow(message)
            expect(context.started.length).toBe(0)
            expect(context.gains.length).toBe(0)
            expect(context.bufferLengths.length).toBe(0)
        }
        test("burstCount below one", async () => {
            await rejects({burstCount: 0}, "burstCount")
            await rejects({burstCount: -3}, "burstCount")
        })
        test("a fractional burstCount", async () => {
            await rejects({burstCount: 2.5}, "burstCount")
        })
        test("a non-positive burst spacing", async () => {
            await rejects({burstSpacingSeconds: 0}, "burstSpacingSeconds")
            await rejects({burstSpacingSeconds: -0.5}, "burstSpacingSeconds")
        })
        test("a non-finite burst spacing", async () => {
            await rejects({burstSpacingSeconds: Number.NaN}, "burstSpacingSeconds")
            await rejects({burstSpacingSeconds: Number.POSITIVE_INFINITY}, "burstSpacingSeconds")
        })
        test("a non-finite gain", async () => {
            await rejects({gainDb: Number.NaN}, "gainDb")
            await rejects({gainDb: Number.NEGATIVE_INFINITY}, "gainDb")
        })
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
            ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]), undefined, [capture]),
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
    test("a capture that cannot be opened leaves nothing connected to the output", async () => {
        // The processor a capture node needs is registered per context; a host that never added the
        // module throws here, after the gain node has already been put on the output.
        const context = makeContext("running", 0.02)
        await expect(measure(context, {}, {
            ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30])),
            createCapture: () => {throw new Error("latency-capture-processor is not registered")}
        })).rejects.toThrow("latency-capture-processor is not registered")
        expect(context.gains[0].disconnected).toBe(true)
    })
    test("a rejecting analyze leaves nothing connected", async () => {
        const context = makeContext("running", 0.02)
        const capture = makeCapture()
        const failing = async () => {throw new Error("worker died")}
        await expect(measure(context, {}, {...deps(failing, undefined, [capture])})).rejects.toThrow("worker died")
        expect(capture.stopped).toBe(true)
        expect(context.gains[0].disconnected).toBe(true)
    })
    describe("second capture anchor", () => {
        test("opens in the first burst's tail, on the same source, and both anchors are analysed", async () => {
            const context = makeContext("running", 0.02)
            const anchors = [makeCapture(100.05), makeCapture(100.2)]
            const analysed: Array<number> = []
            const dependencies = deps(analysesOf(
                analysisOf([0.031, 0.031, 0.031], [30, 30, 30]),
                analysisOf([Number.NaN, 0.031, 0.031], [Number.NEGATIVE_INFINITY, 30, 30])), undefined, anchors)
            const result = await measure(context, {}, {
                ...dependencies,
                analyze: async input => {
                    analysed.push(input.captureStartTime)
                    return dependencies.analyze(input)
                }
            })
            const referenceSeconds = (Math.pow(2, InputLatencyCalibration.MlsOrder) - 1) / 48000
            expect(anchors[0].createdAt).toBe(100.0) // before the bursts were scheduled
            // At the first burst's scheduled end, so constructing it cannot disturb that burst.
            expect(anchors[1].createdAt).toBeCloseTo(context.started[0] + referenceSeconds, 9)
            expect(anchors[1].createdAt).toBeLessThan(context.started[1]) // and before the second burst
            expect(anchors[0].connectedTo).toBeDefined()
            expect(anchors[1].connectedTo).toBe(anchors[0].connectedTo)
            expect(anchors.every(anchor => anchor.stopped)).toBe(true)
            expect(analysed).toEqual([100.05, 100.2]) // one analyze call per anchor, primary first
            expect(result.captureStartTimes).toEqual([100.05, 100.2])
            expect(result.burstDelays[0]).toEqual([0.031, 0.031, 0.031])
            expect(result.burstDelays[1][0]).toBeNaN() // the burst that started before this anchor
            expect(result.roundTripSecondsSecondary).toBeCloseTo(0.031, 6)
            expect(result.verdict).toBe("ok")
            expect(result.reason).toBeUndefined()
        })
        test("agreeing anchors keep the primary figures and the existing verdict", async () => {
            const context = makeContext("running", 0.02)
            const withinBound = 0.031 + 0.4 * 128 / 48000
            const result = await measure(context, {}, deps(analysesOf(
                analysisOf([0.031, 0.031, 0.031], [30, 31, 29]),
                analysisOf([withinBound, withinBound, withinBound], [40, 40, 40])),
            undefined, [makeCapture(100.05), makeCapture(100.2)]))
            expect(result.verdict).toBe("ok")
            expect(result.reason).toBeUndefined()
            expect(result.roundTripSeconds).toBeCloseTo(0.031, 6)
            expect(result.correlationRatioDb).toBe(29) // the primary anchor's, not the secondary's
            expect(result.roundTripSecondsSecondary).toBeCloseTo(withinBound, 6)
        })
        test("anchors disagreeing by more than half a render quantum read noisy with the reason", async () => {
            const context = makeContext("running", 0.02)
            const oneQuantumShort = 0.031 - 128 / 48000
            const result = await measure(context, {}, deps(analysesOf(
                analysisOf([0.031, 0.031, 0.031], [30, 30, 30]),
                analysisOf([oneQuantumShort, oneQuantumShort, oneQuantumShort], [30, 30, 30])),
            undefined, [makeCapture(100.05), makeCapture(100.2)]))
            expect(result.verdict).toBe("noisy")
            expect(result.reason).toBe(InputLatencyCalibration.AnchorsDisagreeReason)
            // The reported figures stay the primary anchor's; both anchors' delays are disclosed.
            expect(result.roundTripSeconds).toBeCloseTo(0.031, 6)
            expect(result.spreadSeconds).toBeCloseTo(0.0, 9)
            expect(result.identifiedBursts).toBe(3)
            expect(result.roundTripSecondsSecondary).toBeCloseTo(oneQuantumShort, 6)
        })
        test("the agreement bound is half a render quantum at the context's rate", async () => {
            expect(InputLatencyCalibration.anchorAgreementSeconds(48000)).toBeCloseTo(0.5 * 128 / 48000, 12)
            expect(InputLatencyCalibration.anchorAgreementSeconds(44100)).toBeCloseTo(0.5 * 128 / 44100, 12)
        })
        test("a secondary anchor that identifies nothing is reported but does not fail the result", async () => {
            const context = makeContext("running", 0.02)
            const result = await measure(context, {}, deps(analysesOf(
                analysisOf([0.031, 0.031, 0.031], [30, 30, 30]),
                analysisOf([Number.NaN, Number.NaN, Number.NaN], [3, 2, 4])),
            undefined, [makeCapture(100.05), makeCapture(100.2)]))
            expect(result.verdict).toBe("ok")
            expect(result.reason).toBe(InputLatencyCalibration.SecondaryAnchorUnavailableReason)
            expect(result.roundTripSeconds).toBeCloseTo(0.031, 6)
            expect(result.roundTripSecondsSecondary).toBeNaN()
        })
        test("no-signal follows the primary anchor even when the secondary identified bursts", async () => {
            const context = makeContext("running", 0.02)
            const result = await measure(context, {}, deps(analysesOf(
                analysisOf([Number.NaN, Number.NaN, Number.NaN], [3, 2, 4]),
                analysisOf([0.031, 0.031, 0.031], [30, 30, 30])),
            undefined, [makeCapture(100.05), makeCapture(100.2)]))
            expect(result.verdict).toBe("no-signal")
            expect(result.roundTripSeconds).toBeNaN()
            expect(result.roundTripSecondsSecondary).toBeNaN()
            expect(result.captureStartTimes).toEqual([Number.NaN, Number.NaN])
            expect(result.burstDelays).toEqual([[], []])
        })
        test("a clock that stalls before the second anchor opens stops the first and gives up", async () => {
            const context = makeContext("running", 0.02)
            const anchors = [makeCapture(100.05), makeCapture(100.2)]
            const result = await measure(context, {}, {
                ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]), undefined, anchors),
                waitUntil: async (_context, time) => {throw new InputLatencyCalibration.ClockStalled(time)}
            })
            expect(result.verdict).toBe("context-not-running")
            expect(anchors[0].stopped).toBe(true)
            expect(anchors[1].stopped).toBe(false) // never opened
            expect(context.gains[0].disconnected).toBe(true)
        })
        test("a wait that throws anything else stops what was opened before rethrowing", async () => {
            const context = makeContext("running", 0.02)
            const anchors = [makeCapture(100.05), makeCapture(100.2)]
            let waits = 0
            await expect(measure(context, {}, {
                ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]), undefined, anchors),
                waitUntil: async (context, time) => {
                    if (waits++ === 0) {
                        (context as unknown as FakeContext).currentTime = time
                        return
                    }
                    throw new Error("context closed")
                }
            })).rejects.toThrow("context closed")
            expect(anchors.every(anchor => anchor.stopped)).toBe(true)
            expect(context.gains[0].disconnected).toBe(true)
        })
        test("a clock that stalls after the second anchor opened stops both", async () => {
            const context = makeContext("running", 0.02)
            const anchors = [makeCapture(100.05), makeCapture(100.2)]
            let waits = 0
            const result = await measure(context, {}, {
                ...deps(analysisOf([0.03, 0.03, 0.03], [30, 30, 30]), undefined, anchors),
                waitUntil: async (context, time) => {
                    if (waits++ === 0) {
                        (context as unknown as FakeContext).currentTime = time
                        return
                    }
                    throw new InputLatencyCalibration.ClockStalled(time)
                }
            })
            expect(result.verdict).toBe("context-not-running")
            expect(anchors.every(anchor => anchor.stopped)).toBe(true)
            expect(context.gains[0].disconnected).toBe(true)
        })
    })
    test("emptyResult carries no anchor diagnostics", () => {
        const result = InputLatencyCalibration.emptyResult("no-stream", 48000, 3, 1700000000000)
        expect(result.roundTripSecondsSecondary).toBeNaN()
        expect(result.captureStartTimes).toEqual([Number.NaN, Number.NaN])
        expect(result.burstDelays).toEqual([[], []])
        expect(result.reason).toBeUndefined()
    })
})
