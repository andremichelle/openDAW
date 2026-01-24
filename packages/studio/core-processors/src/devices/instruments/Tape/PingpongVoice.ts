import {int} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {Voice} from "./Voice"
import {VoiceState} from "./VoiceState"
import {VOICE_FADE_DURATION, LOOP_FADE_DURATION, LOOP_MARGIN_START, LOOP_MARGIN_END} from "./constants"

/**
 * PingpongVoice plays a segment with bidirectional (forward-backward) looping.
 *
 * Behavior:
 * - First iteration: plays from segment start forward to loopEnd (attack + loop region)
 * - At loopEnd: crossfades while reversing direction
 * - At loopStart: crossfades while reversing direction again
 * - Bounces within margin region indefinitely until fade-out
 * - Uses equal-power crossfade (cos/sin) at bounce points to avoid clicks
 * - Fade-in only if start position > 0 (cutting into existing audio)
 * - Fade-out controlled by sequencer via startFadeOut()
 *
 * @see README.md D8, D10, D11, D12
 */
export class PingpongVoice implements Voice {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #playbackRate: number
    readonly #loopStart: number  // start + LOOP_MARGIN_START (in samples)
    readonly #loopEnd: number    // end - LOOP_MARGIN_END (in samples)
    readonly #voiceFadeLengthSamples: number
    readonly #voiceFadeLengthInverse: number
    readonly #bounceFadeLengthSamples: number

    #segmentEnd: number

    #state: VoiceState = VoiceState.Active
    #fadeDirection: number = 0.0
    #fadeProgress: number = 0.0
    #readPosition: number = 0.0
    #direction: number = 1.0  // +1.0 = forward, -1.0 = backward
    #bounceProgress: number = 0.0
    #bouncePosition: number = 0.0
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
     * @param initialState Optional: start at this position/direction instead of segmentStart
     *        Used when spawning mid-segment (e.g., BPM change requires looping).
     *        The state should be computed by the sequencer to match where a pingpong
     *        voice would have been if it had started from the beginning.
     */
    constructor(
        output: AudioBuffer,
        data: AudioData,
        segmentStart: number,
        segmentEnd: number,
        playbackRate: number,
        blockOffset: int,
        sampleRate: number,
        initialState?: {position: number, direction: number}
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
        this.#bounceFadeLengthSamples = Math.round(LOOP_FADE_DURATION * sampleRate)

        // Start at provided state or segment start moving forward
        this.#readPosition = initialState?.position ?? segmentStart
        this.#direction = initialState?.direction ?? 1.0
        this.#blockOffset = blockOffset
        this.#fadeOutBlockOffset = 0
        this.#bounceProgress = 0.0
        this.#bouncePosition = 0.0

        // Always fade-in when spawning mid-segment (initialState provided)
        // Otherwise, fade-in only if not starting at position 0
        if (initialState !== undefined || segmentStart > 0) {
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

    isFadingOut(): boolean {
        return this.#state === VoiceState.Fading && this.#fadeDirection < 0
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

    process(bufferStart: int, bufferCount: int, fadingGainBuffer: Float32Array): void {
        if (this.#state === VoiceState.Done) {return}
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        const loopStart = this.#loopStart
        const loopEnd = this.#loopEnd
        const bounceStartForward = loopEnd - this.#bounceFadeLengthSamples
        const bounceStartBackward = loopStart + this.#bounceFadeLengthSamples
        const voiceFadeLengthSamples = this.#voiceFadeLengthSamples
        const voiceFadeLengthInverse = this.#voiceFadeLengthInverse
        const bounceFadeLengthSamples = this.#bounceFadeLengthSamples
        const playbackRate = this.#playbackRate
        const fadeOutBlockOffset = this.#fadeOutBlockOffset
        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let fadeProgress = this.#fadeProgress
        let readPosition = this.#readPosition
        let direction = this.#direction
        let bounceProgress = this.#bounceProgress
        let bouncePosition = this.#bouncePosition
        for (let i = this.#blockOffset; i < bufferCount; i++) {
            if (state === VoiceState.Done) {break}
            const j = bufferStart + i
            let amplitude: number
            if (state === VoiceState.Fading) {
                if (fadeDirection > 0) {
                    amplitude = fadeProgress * voiceFadeLengthInverse
                    fadeProgress += 1.0
                    if (fadeProgress >= voiceFadeLengthSamples) {
                        state = VoiceState.Active
                        fadeProgress = 0.0
                        fadeDirection = 0.0
                    }
                } else {
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
                amplitude = 1.0
            }
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
            if (bounceProgress === 0.0) {
                if (direction > 0.0 && readPosition >= bounceStartForward) {
                    bounceProgress = 1.0
                    bouncePosition = loopEnd
                } else if (direction < 0.0 && readPosition <= bounceStartBackward) {
                    bounceProgress = 1.0
                    bouncePosition = loopStart
                }
            }
            if (bounceProgress > 0.0) {
                const bounceInt = bouncePosition | 0
                if (bounceInt >= 0 && bounceInt < numberOfFrames - 1) {
                    const alpha = bouncePosition - bounceInt
                    const bL = framesL[bounceInt]
                    const bR = framesR[bounceInt]
                    const bounceSampleL = bL + alpha * (framesL[bounceInt + 1] - bL)
                    const bounceSampleR = bR + alpha * (framesR[bounceInt + 1] - bR)
                    const t = bounceProgress / bounceFadeLengthSamples
                    const fadeOut = Math.cos(t * Math.PI * 0.5)
                    const fadeIn = Math.sin(t * Math.PI * 0.5)
                    sampleL = sampleL * fadeOut + bounceSampleL * fadeIn
                    sampleR = sampleR * fadeOut + bounceSampleR * fadeIn
                }
                bouncePosition -= direction * playbackRate
                bounceProgress += 1.0
                if (bounceProgress >= bounceFadeLengthSamples) {
                    readPosition = bouncePosition
                    direction = -direction
                    bounceProgress = 0.0
                }
            }
            const finalAmplitude = amplitude * fadingGainBuffer[i]
            outL[j] += sampleL * finalAmplitude
            outR[j] += sampleR * finalAmplitude
            readPosition += direction * playbackRate
        }
        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#fadeProgress = fadeProgress
        this.#readPosition = readPosition
        this.#direction = direction
        this.#bounceProgress = bounceProgress
        this.#bouncePosition = bouncePosition
        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }
}
