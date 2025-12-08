import {int} from "@opendaw/lib-std"

/**
 * Voice interface for tape playback.
 *
 * Voices are "dumb" - they only play audio with fade-in/fade-out on command.
 * All timing decisions are made by the sequencer.
 */
export interface Voice {
    /**
     * Returns true when voice has finished playback and can be removed.
     */
    done(): boolean

    /**
     * Commands the voice to begin fading out.
     * @param blockOffset Sample offset within the current block where fade-out should begin
     */
    startFadeOut(blockOffset: int): void

    /**
     * Returns the current read position in samples.
     * Used by sequencer for drift detection.
     */
    readPosition(): number

    /**
     * Returns the segment end position in samples.
     * Used by sequencer to trigger fade-out when voice reaches segment end.
     */
    segmentEnd(): number

    /**
     * Updates the segment end position.
     * Called by sequencer when drift detection allows voice to continue into next transient.
     */
    setSegmentEnd(endSamples: number): void

    /**
     * Renders audio samples to the output buffer.
     * @param bufferStart Start position in the output buffer
     * @param bufferCount Number of samples to process
     */
    process(bufferStart: int, bufferCount: int): void
}
