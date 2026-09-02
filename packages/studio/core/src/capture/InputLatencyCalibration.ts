import {int, Optional, panic} from "@opendaw/lib-std"
import {dbToGain, LatencyCalibrationProtocol, LatencyProbe, LatencyProbes} from "@opendaw/lib-dsp"
import {Workers} from "../Workers"
import {LatencyCaptureNode} from "./LatencyCaptureNode"

/**
 * Loopback input-latency calibration: scheduled probe bursts on the AudioContext clock, captured through a
 * worklet that reports its first-frame context time, located by cross-correlation in the SDK worker.
 * See @opendaw/lib-dsp latency-calibration for the probes and the analysis.
 */
export namespace InputLatencyCalibration {
    export const MlsOrder = 15
    /** The burst every measurement emits unless the caller passes another one. */
    export const DefaultProbe: LatencyProbe = LatencyProbes.mls(MlsOrder)
    export const BurstCount = 3
    export const BurstTailSeconds = 0.5
    export const LeadInSeconds = 0.1
    export const MaxRoundTripSeconds = 0.6
    export const RatioThresholdDb = 18.0
    export const SpreadBoundSeconds = 0.001
    export const GainDb = -12.0
    /** Wall-clock grace the default wait allows the context clock beyond the time it is waiting for. */
    export const WaitDeadlineMarginSeconds = 2.0

    /** The context clock stopped advancing mid-run: a suspended, closed or dead output device. */
    export class ClockStalled extends Error {
        constructor(time: number) {super(`AudioContext clock did not reach ${time}`)}
    }

    export interface Options {burstCount?: int, probe?: LatencyProbe, burstSpacingSeconds?: number, gainDb?: number}

    export type Verdict = "ok" | "noisy" | "no-signal" | "context-not-running" | "no-stream" | "transport-running"

    export interface Result {
        verdict: Verdict
        roundTripSeconds: number
        outputLatencySeconds: number
        outputLatencyReported: boolean
        inputLatencySeconds: number
        spreadSeconds: number
        correlationRatioDb: number
        identifiedBursts: int
        scheduledBursts: int
        sampleRate: number
        measuredAt: number
        /** Name of the probe the bursts carried, so a stored or displayed figure names its signal. */
        probe: string
    }

    export interface Capture {
        connectFrom(source: AudioNode): void
        stop(): Promise<{startTime: number, frames: Float32Array}>
    }

    export interface Dependencies {
        analyze: LatencyCalibrationProtocol["analyze"]
        createCapture: (context: BaseAudioContext) => Capture
        waitUntil: (context: BaseAudioContext, time: number) => Promise<void>
        now: () => number
    }

    const defaultDependencies = (): Dependencies => ({
        analyze: input => Workers.LatencyCalibration.analyze(input),
        createCapture: context => {
            const node = LatencyCaptureNode.create(context)
            let connected: Optional<AudioNode> = undefined
            return {
                connectFrom: source => {
                    source.connect(node)
                    connected = source
                },
                stop: async () => {
                    const capture = await node.stop()
                    connected?.disconnect(node)
                    return capture
                }
            }
        },
        waitUntil: (context, time) => new Promise((resolve, reject) => {
            const deadline = Date.now() + (time - context.currentTime + WaitDeadlineMarginSeconds) * 1000.0
            const tick = () => {
                if (context.currentTime >= time) {
                    resolve()
                } else if (Date.now() >= deadline) {
                    reject(new ClockStalled(time))
                } else {
                    setTimeout(tick, 20)
                }
            }
            tick()
        }),
        now: () => Date.now()
    })

    /** A result carrying only the verdict, for the paths that never reach the analysis. */
    export const emptyResult = (verdict: Verdict, sampleRate: number, scheduledBursts: int, now: number,
                                probe: string = DefaultProbe.name): Result => ({
        verdict, roundTripSeconds: Number.NaN, outputLatencySeconds: 0.0, outputLatencyReported: false,
        inputLatencySeconds: Number.NaN, spreadSeconds: 0.0, correlationRatioDb: Number.NEGATIVE_INFINITY,
        identifiedBursts: 0, scheduledBursts, sampleRate, measuredAt: now, probe
    })

    export const measure = async (context: AudioContext, source: AudioNode, output: AudioNode,
                                  options: Options = {}, dependencies: Partial<Dependencies> = {}): Promise<Result> => {
        const defaults = defaultDependencies()
        const {analyze, createCapture, waitUntil, now} = {...defaults, ...dependencies}
        const burstCount = options.burstCount ?? BurstCount
        const probe = options.probe ?? DefaultProbe
        const gainDb = options.gainDb ?? GainDb
        const {sampleRate} = context
        // The default analysis dispatches to the SDK worker, so a host that never installed the workers
        // would fail only after the probe had already played. An injected analyze never reaches them.
        if (analyze === defaults.analyze && Workers.messenger.isEmpty()) {return panic("Workers are not installed")}
        if (context.state !== "running") {await context.resume()}
        if (context.state !== "running") {
            return emptyResult("context-not-running", sampleRate, burstCount, now(), probe.name)
        }
        const reference = probe.render(sampleRate)
        const burstSpacingSeconds = options.burstSpacingSeconds ?? (reference.length / sampleRate + BurstTailSeconds)
        const buffer = context.createBuffer(1, reference.length, sampleRate)
        buffer.getChannelData(0).set(reference)
        const gainNode = context.createGain()
        gainNode.gain.value = dbToGain(gainDb)
        gainNode.connect(output)
        const capture = createCapture(context)
        capture.connectFrom(source)
        const firstBurst = context.currentTime + LeadInSeconds
        const burstStartTimes: Array<number> = []
        for (let burst = 0; burst < burstCount; burst++) {
            const startTime = firstBurst + burst * burstSpacingSeconds
            const node = context.createBufferSource()
            node.buffer = buffer
            node.connect(gainNode)
            node.start(startTime)
            burstStartTimes.push(startTime)
        }
        const lastEnd = burstStartTimes[burstCount - 1] + reference.length / sampleRate
        try {
            await waitUntil(context, lastEnd + MaxRoundTripSeconds)
        } catch (reason) {
            if (!(reason instanceof ClockStalled)) {throw reason}
            // The frames cannot arrive if the clock stopped, so the capture's own promise is abandoned;
            // stopping it still releases the worklet and its connection to the source.
            capture.stop().catch(() => {})
            gainNode.disconnect()
            return emptyResult("context-not-running", sampleRate, burstCount, now(), probe.name)
        }
        // Read only now: Chrome reports 0 until audio has been rendered to the device.
        const reported = context.outputLatency as Optional<number>
        const outputLatencyReported = reported !== undefined && Number.isFinite(reported) && reported > 0.0
        const outputLatencySeconds = outputLatencyReported ? reported : 0.0
        gainNode.disconnect()
        const {startTime, frames} = await capture.stop()
        const analysis = await analyze({
            sampleRate, capture: frames, captureStartTime: startTime, reference, burstStartTimes,
            maxRoundTripSeconds: MaxRoundTripSeconds, ratioThresholdDb: RatioThresholdDb
        })
        if (analysis.identifiedBursts === 0) {
            return emptyResult("no-signal", sampleRate, burstCount, now(), probe.name)
        }
        const identifiedRatios = analysis.ratiosDb.filter((_, index) => !Number.isNaN(analysis.delays[index]))
        const verdict: Verdict = analysis.identifiedBursts === burstCount && analysis.spreadSeconds <= SpreadBoundSeconds
            ? "ok" : "noisy"
        return {
            verdict,
            roundTripSeconds: analysis.roundTripSeconds,
            outputLatencySeconds,
            outputLatencyReported,
            inputLatencySeconds: analysis.roundTripSeconds - outputLatencySeconds,
            spreadSeconds: analysis.spreadSeconds,
            correlationRatioDb: Math.min(...identifiedRatios),
            identifiedBursts: analysis.identifiedBursts,
            scheduledBursts: burstCount,
            sampleRate,
            measuredAt: now(),
            probe: probe.name
        }
    }
}
