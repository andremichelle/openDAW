import {isDefined, Optional} from "@opendaw/lib-std"

export namespace InputLatency {
    /** Per-track override sentinel: inherit the value from the engine preferences. */
    export const Inherit = -2.0
    /** Treat the input latency as equal to the output latency (doubles the compensation). */
    export const EqualsOutput = -1.0
    /** Use the latency that the capture's own MediaStreamTrack reports, or none if the browser reports none. */
    export const Reported = -3.0
    /**
     * Ceiling for a reported latency, in seconds. Input latency is tens of milliseconds; a report near a
     * second is a misreport, and applying it would shift the take and its waveform by that much.
     */
    export const ReportedMaximum = 1.0

    /** Names the rule that produced a resolved input latency. */
    export type Source =
        "capture" | "preference" | "equals-output" | "reported" | "reported-unavailable" | "reported-out-of-range"

    /** A resolved input latency in seconds together with the rule that produced it. */
    export type Resolution = { seconds: number, source: Source }

    /**
     * Resolves the additional latency (in seconds) to add to the output latency when recording.
     * @param localOverride the per-track value stored in the CaptureAudioBox
     * @param preference the engine-preferences default
     * @param outputLatency the current output latency in seconds
     * @param reportedLatency the latency the capture's MediaStreamTrack reports; omit it when the browser
     *  reports none, which resolves the Reported sentinel to no compensation
     */
    export const resolve = (localOverride: number,
                            preference: number,
                            outputLatency: number,
                            reportedLatency: Optional<number> = undefined): number =>
        resolveWithSource(localOverride, preference, outputLatency, reportedLatency).seconds

    /** Resolves as {@link resolve} does and additionally names which rule won, for diagnostics. */
    export const resolveWithSource = (localOverride: number,
                                      preference: number,
                                      outputLatency: number,
                                      reportedLatency: Optional<number> = undefined): Resolution => {
        const inherits = localOverride === Inherit
        const value = inherits ? preference : localOverride
        if (value === EqualsOutput) {return {seconds: outputLatency, source: "equals-output"}}
        if (value === Reported) {
            if (!isDefined(reportedLatency) || !Number.isFinite(reportedLatency) || reportedLatency <= 0.0) {
                return {seconds: 0.0, source: "reported-unavailable"}
            }
            if (reportedLatency > ReportedMaximum) {
                return {seconds: 0.0, source: "reported-out-of-range"}
            }
            return {seconds: reportedLatency, source: "reported"}
        }
        return {seconds: Math.max(0.0, value), source: inherits ? "preference" : "capture"}
    }
}
