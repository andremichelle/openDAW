import {int, isDefined, Optional, panic, tryCatch} from "@opendaw/lib-std"
import {dbToGain, LatencyCalibrationProtocol, LatencyProbe, LatencyProbes} from "@opendaw/lib-dsp"
import {Workers} from "../Workers"
import {LatencyCaptureNode} from "./LatencyCaptureNode"

/**
 * Loopback input-latency calibration: scheduled probe bursts on the AudioContext clock, captured through a
 * worklet that reports its first-frame context time, located by cross-correlation in the SDK worker.
 * See @opendaw/lib-dsp latency-calibration for the probes and the analysis.
 *
 * The same emission is captured twice, through two worklets opened at different instants: a capture's
 * reported first-frame time has been seen a whole render quantum off on some chains (once in twenty-four
 * calls at 44.1 kHz; the cause is not identified), and one anchor alone cannot tell that from a real
 * round trip, since all of its bursts agree on the wrong figure. The second anchor makes the miss visible
 * as a disagreement between the two.
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
    export const RenderQuantumFrames = 128
    /** How much of a render quantum the two capture anchors may differ by before the run is distrusted. */
    export const AnchorAgreementQuanta = 0.5
    /**
     * The bound the two anchors' round trips must agree within, in seconds at the context's rate. Half a
     * render quantum: a chain that reports one anchor's first-frame time a whole quantum off clears it,
     * ordinary sub-sample noise on the correlation peak does not.
     */
    export const anchorAgreementSeconds = (sampleRate: number): number =>
        AnchorAgreementQuanta * RenderQuantumFrames / sampleRate
    export const AnchorsDisagreeReason = "capture anchors disagree"
    export const SecondaryAnchorUnavailableReason = "secondary anchor unavailable"

    /** The context clock stopped advancing mid-run: a suspended, closed or dead output device. */
    export class ClockStalled extends Error {
        constructor(time: number) {super(`AudioContext clock did not reach ${time}`)}
    }

    export interface Options {burstCount?: int, probe?: LatencyProbe, burstSpacingSeconds?: number, gainDb?: number}

    export type Verdict = "ok" | "noisy" | "no-signal" | "context-not-running" | "no-stream" | "transport-running"

    export interface Result {
        verdict: Verdict
        /** The primary anchor's round trip; every derived figure below is that anchor's too. */
        roundTripSeconds: number
        /** The secondary anchor's round trip, NaN when it identified no burst. */
        roundTripSecondsSecondary: number
        outputLatencySeconds: number
        outputLatencyReported: boolean
        inputLatencySeconds: number
        spreadSeconds: number
        correlationRatioDb: number
        identifiedBursts: int
        scheduledBursts: int
        /** First-frame context time of the primary and the secondary anchor. */
        captureStartTimes: [number, number]
        /** Per-anchor, per-burst delays, so a disagreement can be read burst by burst. */
        burstDelays: [ReadonlyArray<number>, ReadonlyArray<number>]
        sampleRate: number
        measuredAt: number
        /** Name of the probe the bursts carried, so a stored or displayed figure names its signal. */
        probe: string
        /** Why the verdict reads as it does, when the figures alone do not say so. */
        reason?: string
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
                    // The chain this was connected to can be destroyed mid-run (a disarm, a device
                    // change): the edge is already gone and `disconnect` throws InvalidAccessError.
                    // The frames are in hand by then, so the teardown must not lose them to that.
                    tryCatch(() => connected?.disconnect(node))
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
        verdict, roundTripSeconds: Number.NaN, roundTripSecondsSecondary: Number.NaN,
        outputLatencySeconds: 0.0, outputLatencyReported: false,
        inputLatencySeconds: Number.NaN, spreadSeconds: 0.0, correlationRatioDb: Number.NEGATIVE_INFINITY,
        identifiedBursts: 0, scheduledBursts, captureStartTimes: [Number.NaN, Number.NaN], burstDelays: [[], []],
        sampleRate, measuredAt: now, probe
    })

    export const measure = async (context: AudioContext, source: AudioNode, output: AudioNode,
                                  options: Options = {}, dependencies: Partial<Dependencies> = {}): Promise<Result> => {
        const defaults = defaultDependencies()
        const {analyze, createCapture, waitUntil, now} = {...defaults, ...dependencies}
        const burstCount = options.burstCount ?? BurstCount
        const probe = options.probe ?? DefaultProbe
        const gainDb = options.gainDb ?? GainDb
        const spacingOption = options.burstSpacingSeconds
        const {sampleRate} = context
        // Every one of these leaves the last burst's scheduled end as NaN, and the default clock wait
        // can neither reach a NaN time nor time out on it: the routine would hang with an anchor open
        // and the probe already audible. A caller mistake, so it is refused before anything is built.
        if (!Number.isInteger(burstCount) || burstCount < 1) {
            return panic(`burstCount must be a positive integer (got ${burstCount})`)
        }
        if (isDefined(spacingOption) && !(Number.isFinite(spacingOption) && spacingOption > 0.0)) {
            return panic(`burstSpacingSeconds must be a positive, finite number (got ${spacingOption})`)
        }
        if (!Number.isFinite(gainDb)) {
            return panic(`gainDb must be a finite number (got ${gainDb})`)
        }
        // The default analysis dispatches to the SDK worker, so a host that never installed the workers
        // would fail only after the probe had already played. An injected analyze never reaches them.
        if (analyze === defaults.analyze && Workers.messenger.isEmpty()) {return panic("Workers are not installed")}
        if (context.state !== "running") {await context.resume()}
        if (context.state !== "running") {
            return emptyResult("context-not-running", sampleRate, burstCount, now(), probe.name)
        }
        const reference = probe.render(sampleRate)
        const referenceSeconds = reference.length / sampleRate
        const burstSpacingSeconds = spacingOption ?? (referenceSeconds + BurstTailSeconds)
        const buffer = context.createBuffer(1, reference.length, sampleRate)
        buffer.getChannelData(0).set(reference)
        const gainNode = context.createGain()
        gainNode.gain.value = dbToGain(gainDb)
        // Both anchors capture the same source until the same end time; only the instant they open differs.
        const captures: Array<Capture> = []
        const openCapture = () => {
            const capture = createCapture(context)
            capture.connectFrom(source)
            captures.push(capture)
        }
        const burstStartTimes: Array<number> = []
        try {
            // Everything from the first edge on is inside the try: opening a capture constructs a
            // worklet node, which throws on a context whose processor module was never added, and a
            // gain node already put on the output would then stay there with nothing to remove it.
            gainNode.connect(output)
            openCapture()
            const firstBurst = context.currentTime + LeadInSeconds
            for (let burst = 0; burst < burstCount; burst++) {
                const startTime = firstBurst + burst * burstSpacingSeconds
                const node = context.createBufferSource()
                node.buffer = buffer
                node.connect(gainNode)
                node.start(startTime)
                burstStartTimes.push(startTime)
            }
            // The second anchor opens at the end of the first burst's emission, not at its onset:
            // constructing a capture worklet runs user code on the render thread, and an overrun there
            // would fall inside the burst while it is still playing. The first anchor keeps capturing
            // that burst's echo for one round trip past this instant, so the construction is out of the
            // emission but not out of the first anchor's window — the second anchor misses the first
            // burst either way, so the wait costs it nothing. A caller who packs the bursts closer than
            // the probe is long leaves no gap to aim for; the spacing then caps the wait so the anchor
            // cannot open past the next burst.
            await waitUntil(context, firstBurst + Math.min(referenceSeconds, burstSpacingSeconds))
            openCapture()
            await waitUntil(context, burstStartTimes[burstCount - 1] + referenceSeconds + MaxRoundTripSeconds)
        } catch (reason) {
            // Neither anchor's frames can arrive if the clock stopped, so their promises are abandoned;
            // stopping them still posts the stop message, which is all a dead render thread can act on.
            captures.forEach(capture => capture.stop().catch(() => {}))
            gainNode.disconnect()
            if (!(reason instanceof ClockStalled)) {throw reason}
            return emptyResult("context-not-running", sampleRate, burstCount, now(), probe.name)
        }
        // Read only now: Chrome reports 0 until audio has been rendered to the device.
        const reported = context.outputLatency as Optional<number>
        const outputLatencyReported = reported !== undefined && Number.isFinite(reported) && reported > 0.0
        const outputLatencySeconds = outputLatencyReported ? reported : 0.0
        gainNode.disconnect()
        const [primaryCapture, secondaryCapture] = await Promise.all(captures.map(capture => capture.stop()))
        // One analyze call per anchor: the same protocol, run twice over the same emission.
        const common = {
            sampleRate, reference, burstStartTimes,
            maxRoundTripSeconds: MaxRoundTripSeconds, ratioThresholdDb: RatioThresholdDb
        }
        const [primary, secondary] = await Promise.all([
            analyze({...common, capture: primaryCapture.frames, captureStartTime: primaryCapture.startTime}),
            analyze({...common, capture: secondaryCapture.frames, captureStartTime: secondaryCapture.startTime})
        ])
        if (primary.identifiedBursts === 0) {
            return emptyResult("no-signal", sampleRate, burstCount, now(), probe.name)
        }
        const identifiedRatios = primary.ratiosDb.filter((_, index) => !Number.isNaN(primary.delays[index]))
        // The second anchor opens after the first burst, so it usually identifies one burst fewer; that
        // is expected and only its round trip is compared. An anchor that identified nothing at all says
        // nothing about the first one, so it is disclosed rather than held against the measurement.
        const anchorsDisagree = secondary.identifiedBursts > 0
            && Math.abs(primary.roundTripSeconds - secondary.roundTripSeconds) > anchorAgreementSeconds(sampleRate)
        const verdict: Verdict = anchorsDisagree ? "noisy"
            : primary.identifiedBursts === burstCount && primary.spreadSeconds <= SpreadBoundSeconds
                ? "ok" : "noisy"
        return {
            verdict,
            roundTripSeconds: primary.roundTripSeconds,
            roundTripSecondsSecondary: secondary.roundTripSeconds,
            outputLatencySeconds,
            outputLatencyReported,
            inputLatencySeconds: primary.roundTripSeconds - outputLatencySeconds,
            spreadSeconds: primary.spreadSeconds,
            correlationRatioDb: Math.min(...identifiedRatios),
            identifiedBursts: primary.identifiedBursts,
            scheduledBursts: burstCount,
            captureStartTimes: [primaryCapture.startTime, secondaryCapture.startTime],
            burstDelays: [primary.delays, secondary.delays],
            sampleRate,
            measuredAt: now(),
            probe: probe.name,
            reason: anchorsDisagree ? AnchorsDisagreeReason
                : secondary.identifiedBursts === 0 ? SecondaryAnchorUnavailableReason : undefined
        }
    }
}
