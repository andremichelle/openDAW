import {int} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {Voice} from "./Voice"
import {VoiceState} from "./VoiceState"
import {VOICE_FADE_DURATION} from "./constants"

/**
 * OnceVoice plays a segment once without looping.
 *
 * Behavior:
 * - Plays from segment start to segment end (or until fade-out is triggered)
 * - Fade-in only if start position > 0 (cutting into existing audio)
 * - Fade-out controlled by sequencer via startFadeOut()
 * - If audio is exhausted before fade-out is called, outputs silence
 *
 * @see PLAYBACK_SYSTEM.md D9, D10
 */
export class OnceVoice implements Voice {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #playbackRate: number
    readonly #fadeLengthSamples: number
    readonly #fadeLengthInverse: number

    #segmentEnd: number

    #state: VoiceState = VoiceState.Active
    #fadeDirection: number = 0.0
    #fadeProgress: number = 0.0
    #readPosition: number = 0.0
    #blockOffset: int = 0
    #fadeOutBlockOffset: int = 0

    /**
     * @param output Output buffer to render into (additive)
     * @param data Audio data source
     * @param segmentStart Start position in samples
     * @param segmentEnd End position in samples - outputs silence beyond this but keeps advancing
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
        this.#fadeLengthSamples = Math.round(VOICE_FADE_DURATION * sampleRate)
        this.#fadeLengthInverse = 1.0 / this.#fadeLengthSamples
        this.#readPosition = segmentStart
        this.#blockOffset = blockOffset
        this.#fadeOutBlockOffset = 0

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
            // fadeProgress is how far into fade-in we are
            // We want to start fade-out from the current amplitude level
            const currentAmplitude = this.#fadeProgress * this.#fadeLengthInverse
            this.#fadeProgress = this.#fadeLengthSamples * (1.0 - currentAmplitude)
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

        const segmentEnd = this.#segmentEnd
        const fadeLengthSamples = this.#fadeLengthSamples
        const fadeLengthInverse = this.#fadeLengthInverse
        const playbackRate = this.#playbackRate
        const fadeOutBlockOffset = this.#fadeOutBlockOffset

        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let fadeProgress = this.#fadeProgress
        let readPosition = this.#readPosition

        for (let i = this.#blockOffset; i < bufferCount; i++) {
            if (state === VoiceState.Done) {
                break
            }

            const j = bufferStart + i

            // Calculate amplitude based on state
            let amplitude: number
            if (state === VoiceState.Fading) {
                if (fadeDirection > 0) {
                    // Fading in
                    amplitude = fadeProgress * fadeLengthInverse
                    fadeProgress += 1.0
                    if (fadeProgress >= fadeLengthSamples) {
                        state = VoiceState.Active
                        fadeProgress = 0.0
                        fadeDirection = 0.0
                    }
                } else {
                    // Fading out - wait for fadeOutBlockOffset
                    if (i < fadeOutBlockOffset) {
                        amplitude = 1.0
                    } else {
                        amplitude = 1.0 - fadeProgress * fadeLengthInverse
                        fadeProgress += 1.0
                        if (fadeProgress >= fadeLengthSamples) {
                            state = VoiceState.Done
                            break
                        }
                    }
                }
            } else {
                // Active
                amplitude = 1.0
            }

            // Output audio if within valid range
            // Note: segmentEnd is not checked here - the sequencer controls when to fade out
            const readInt = readPosition | 0
            if (readInt >= 0 && readInt < numberOfFrames - 1) {
                // Linear interpolation for sub-sample accuracy
                const alpha = readPosition - readInt
                const sL = framesL[readInt]
                const sR = framesR[readInt]
                outL[j] += (sL + alpha * (framesL[readInt + 1] - sL)) * amplitude
                outR[j] += (sR + alpha * (framesR[readInt + 1] - sR)) * amplitude
            }
            // else: silence (beyond audio data)

            readPosition += playbackRate
        }

        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#fadeProgress = fadeProgress
        this.#readPosition = readPosition
        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }
}
