import {int} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {Voice} from "./Voice"
import {VoiceState} from "./VoiceState"
import {VOICE_FADE_DURATION, LOOP_FADE_DURATION, LOOP_MARGIN_START, LOOP_MARGIN_END} from "./constants"

/**
 * RepeatVoice plays a segment with forward looping.
 *
 * Behavior:
 * - First iteration: plays from segment start to loopEnd (attack + loop region)
 * - Subsequent iterations: loops within margin region (loopStart to loopEnd)
 * - Crossfades at loop boundary for seamless looping
 * - Fade-in only if start position > 0 (cutting into existing audio)
 * - Fade-out controlled by sequencer via startFadeOut()
 *
 * @see PLAYBACK_SYSTEM.md D8, D10, D11
 */
export class RepeatVoice implements Voice {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #playbackRate: number
    readonly #loopStart: number  // start + LOOP_MARGIN_START (in samples)
    readonly #loopEnd: number    // end - LOOP_MARGIN_END (in samples)
    readonly #voiceFadeLengthSamples: number
    readonly #voiceFadeLengthInverse: number
    readonly #loopFadeLengthSamples: number
    readonly #loopFadeLengthInverse: number

    #segmentEnd: number

    #state: VoiceState = VoiceState.Active
    #fadeDirection: number = 0.0
    #fadeProgress: number = 0.0
    #readPosition: number = 0.0
    #loopCrossfadeProgress: number = 0.0
    #loopCrossfadePosition: number = 0.0
    #blockOffset: int = 0
    #fadeOutBlockOffset: int = 0

    /**
     * @param output Output buffer to render into (additive)
     * @param data Audio data source
     * @param segmentStart Start position in samples (where attack begins)
     * @param segmentEnd End position in samples
     * @param playbackRate Rate of playback (1.0 = original pitch)
     * @param blockOffset Sample offset within first block to start playback
     * @param sampleRate Current sample rate for converting seconds to samples
     */
    constructor(
        output: AudioBuffer,
        data: AudioData,
        segmentStart: number,
        segmentEnd: number,
        playbackRate: number,
        blockOffset: int,
        sampleRate: number
    ) {
        this.#output = output
        this.#data = data
        this.#playbackRate = playbackRate
        this.#segmentEnd = segmentEnd

        // Calculate loop boundaries in samples
        const loopMarginStartSamples = LOOP_MARGIN_START * sampleRate
        const loopMarginEndSamples = LOOP_MARGIN_END * sampleRate
        this.#loopStart = segmentStart + loopMarginStartSamples
        this.#loopEnd = segmentEnd - loopMarginEndSamples

        // Calculate fade lengths in samples
        this.#voiceFadeLengthSamples = Math.round(VOICE_FADE_DURATION * sampleRate)
        this.#voiceFadeLengthInverse = 1.0 / this.#voiceFadeLengthSamples
        this.#loopFadeLengthSamples = Math.round(LOOP_FADE_DURATION * sampleRate)
        this.#loopFadeLengthInverse = 1.0 / this.#loopFadeLengthSamples

        // Start at segment start (to include attack)
        this.#readPosition = segmentStart
        this.#blockOffset = blockOffset
        this.#fadeOutBlockOffset = 0
        this.#loopCrossfadeProgress = 0.0
        this.#loopCrossfadePosition = 0.0

        // D10: Fade-in only if not starting at position 0
        if (segmentStart > 0) {
            this.#state = VoiceState.Fading
            this.#fadeDirection = 1.0
            this.#fadeProgress = 0.0
        } else {
            this.#state = VoiceState.Active
            this.#fadeDirection = 0.0
            this.#fadeProgress = 0.0
        }

        // Handle invalid segment (loop region too small)
        if (this.#loopStart >= this.#loopEnd) {
            this.#state = VoiceState.Done
        }
    }

    done(): boolean {
        return this.#state === VoiceState.Done
    }

    readPosition(): number {
        return this.#readPosition
    }

    segmentEnd(): number {
        return this.#segmentEnd
    }

    setSegmentEnd(endSamples: number): void {
        this.#segmentEnd = endSamples
    }

    startFadeOut(blockOffset: int): void {
        if (this.#state === VoiceState.Done) {
            return
        }

        // Already fading out - don't restart
        if (this.#state === VoiceState.Fading && this.#fadeDirection < 0) {
            return
        }

        if (this.#state === VoiceState.Fading && this.#fadeDirection > 0) {
            // Currently fading in - reverse from current amplitude
            const currentAmplitude = this.#fadeProgress * this.#voiceFadeLengthInverse
            this.#fadeProgress = this.#voiceFadeLengthSamples * (1.0 - currentAmplitude)
        } else {
            // Active - start fresh fade-out
            this.#fadeProgress = 0.0
        }

        this.#state = VoiceState.Fading
        this.#fadeDirection = -1.0
        this.#fadeOutBlockOffset = blockOffset
    }

    process(bufferStart: int, bufferCount: int): void {
        if (this.#state === VoiceState.Done) {
            return
        }

        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]

        const loopStart = this.#loopStart
        const loopEnd = this.#loopEnd
        const loopCrossfadeStart = loopEnd - this.#loopFadeLengthSamples
        const voiceFadeLengthSamples = this.#voiceFadeLengthSamples
        const voiceFadeLengthInverse = this.#voiceFadeLengthInverse
        const loopFadeLengthSamples = this.#loopFadeLengthSamples
        const loopFadeLengthInverse = this.#loopFadeLengthInverse
        const playbackRate = this.#playbackRate
        const fadeOutBlockOffset = this.#fadeOutBlockOffset

        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let fadeProgress = this.#fadeProgress
        let readPosition = this.#readPosition
        let loopCrossfadeProgress = this.#loopCrossfadeProgress
        let loopCrossfadePosition = this.#loopCrossfadePosition

        for (let i = this.#blockOffset; i < bufferCount; i++) {
            if (state === VoiceState.Done) {
                break
            }

            const j = bufferStart + i

            // Calculate voice amplitude based on state
            let amplitude: number
            if (state === VoiceState.Fading) {
                if (fadeDirection > 0) {
                    // Fading in
                    amplitude = fadeProgress * voiceFadeLengthInverse
                    fadeProgress += 1.0
                    if (fadeProgress >= voiceFadeLengthSamples) {
                        state = VoiceState.Active
                        fadeProgress = 0.0
                        fadeDirection = 0.0
                    }
                } else {
                    // Fading out - wait for fadeOutBlockOffset
                    if (i < fadeOutBlockOffset) {
                        amplitude = 1.0
                    } else {
                        amplitude = 1.0 - fadeProgress * voiceFadeLengthInverse
                        fadeProgress += 1.0
                        if (fadeProgress >= voiceFadeLengthSamples) {
                            state = VoiceState.Done
                            break
                        }
                    }
                }
            } else {
                // Active
                amplitude = 1.0
            }

            // Read primary sample with linear interpolation
            let sampleL = 0.0
            let sampleR = 0.0
            const readInt = readPosition | 0
            if (readInt >= 0 && readInt < numberOfFrames - 1) {
                const alpha = readPosition - readInt
                const sL = framesL[readInt]
                const sR = framesR[readInt]
                sampleL = sL + alpha * (framesL[readInt + 1] - sL)
                sampleR = sR + alpha * (framesR[readInt + 1] - sR)
            }

            // Check if we need to start loop crossfade
            if (loopCrossfadeProgress === 0.0 && readPosition >= loopCrossfadeStart) {
                loopCrossfadeProgress = 1.0
                loopCrossfadePosition = loopStart
            }

            // Apply loop crossfade if active
            if (loopCrossfadeProgress > 0.0) {
                const loopReadInt = loopCrossfadePosition | 0
                if (loopReadInt >= 0 && loopReadInt < numberOfFrames - 1) {
                    const alpha = loopCrossfadePosition - loopReadInt
                    const sL = framesL[loopReadInt]
                    const sR = framesR[loopReadInt]
                    const loopSampleL = sL + alpha * (framesL[loopReadInt + 1] - sL)
                    const loopSampleR = sR + alpha * (framesR[loopReadInt + 1] - sR)

                    // Linear crossfade
                    const crossfade = loopCrossfadeProgress * loopFadeLengthInverse
                    sampleL = sampleL * (1.0 - crossfade) + loopSampleL * crossfade
                    sampleR = sampleR * (1.0 - crossfade) + loopSampleR * crossfade
                }

                loopCrossfadePosition += playbackRate
                loopCrossfadeProgress += 1.0

                // When crossfade completes, snap to loop position
                if (loopCrossfadeProgress >= loopFadeLengthSamples) {
                    readPosition = loopCrossfadePosition
                    loopCrossfadeProgress = 0.0
                }
            }

            // Write to output (additive)
            outL[j] += sampleL * amplitude
            outR[j] += sampleR * amplitude

            readPosition += playbackRate
        }

        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#fadeProgress = fadeProgress
        this.#readPosition = readPosition
        this.#loopCrossfadeProgress = loopCrossfadeProgress
        this.#loopCrossfadePosition = loopCrossfadePosition
        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }
}
