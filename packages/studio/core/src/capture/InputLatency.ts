export namespace InputLatency {
    /** Per-track override sentinel: inherit the value from the engine preferences. */
    export const Inherit = -2.0
    /** Treat the input latency as equal to the output latency (doubles the compensation). */
    export const EqualsOutput = -1.0

    /**
     * Resolves the additional latency (in seconds) to add to the output latency when recording.
     * @param localOverride the per-track value stored in the CaptureAudioBox
     * @param preference the engine-preferences default
     * @param outputLatency the current output latency in seconds
     */
    export const resolve = (localOverride: number, preference: number, outputLatency: number): number => {
        const value = localOverride <= Inherit ? preference : localOverride
        return value === EqualsOutput ? outputLatency : Math.max(0, value)
    }
}
