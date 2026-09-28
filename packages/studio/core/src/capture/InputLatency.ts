import {isDefined, Optional} from "@opendaw/lib-std"

export namespace InputLatency {
    /** Per-track override sentinel: inherit the value from the engine preferences. */
    export const Inherit = -2.0
    /** Treat the input latency as equal to the output latency (doubles the compensation). */
    export const EqualsOutput = -1.0
    /** A reported latency above this many seconds is a misreport and is ignored. */
    export const ReportedMaximum = 1.0

    /** Names the rule that produced a resolved input latency. */
    export type Source = "capture" | "preference" | "equals-output"
        | "reported" | "reported-unavailable" | "reported-out-of-range"
    export type Resolution = {seconds: number, source: Source}

    /**
     * Resolves the additional latency (in seconds) to add to the output latency when recording.
     * Zero uses the latency the capture's MediaStreamTrack reports, or none if the browser reports none.
     * @param localOverride the per-track value stored in the CaptureAudioBox
     * @param preference the engine-preferences default
     * @param outputLatency the current output latency in seconds
     * @param reportedLatency the latency the capture's MediaStreamTrack reports, if any
     */
    export const resolve = (localOverride: number, preference: number, outputLatency: number,
                            reportedLatency: Optional<number> = undefined): number =>
        resolveWithSource(localOverride, preference, outputLatency, reportedLatency).seconds

    /** Resolves as {@link resolve} does and names the rule that won, for diagnostics. */
    export const resolveWithSource = (localOverride: number, preference: number, outputLatency: number,
                                      reportedLatency: Optional<number> = undefined): Resolution => {
        const inherits = localOverride <= Inherit
        const value = inherits ? preference : localOverride
        if (value === EqualsOutput) {return {seconds: outputLatency, source: "equals-output"}}
        if (value > 0.0) {return {seconds: value, source: inherits ? "preference" : "capture"}}
        if (!isDefined(reportedLatency) || !Number.isFinite(reportedLatency) || reportedLatency <= 0.0) {
            return {seconds: 0.0, source: "reported-unavailable"}
        }
        if (reportedLatency > ReportedMaximum) {return {seconds: 0.0, source: "reported-out-of-range"}}
        return {seconds: reportedLatency, source: "reported"}
    }
}
