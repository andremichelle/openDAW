import {int} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {VoiceState} from "./VoiceState"

/**
 * PitchVoice is used for pitch-stretch mode (warp marker based).
 * It does NOT implement the Voice interface as it's managed differently
 * by the TapeDeviceProcessor (not via TimeStretchSequencer).
 *
 * Uses fadeDirection to track fading in (+1) vs fading out (-1).
 */
export class PitchVoice {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #fadeLength: number

    #state: VoiceState
    #fadeDirection: number
    #readPosition: number
    #fadeProgress: number = 0.0
    #playbackRate: number
    #blockOffset: int
    #fadeOutBlockOffset: int = 0

    constructor(output: AudioBuffer, data: AudioData, fadeLength: number, playbackRate: number,
                offset: number = 0.0, blockOffset: int = 0) {
        this.#output = output
        this.#data = data
        this.#fadeLength = fadeLength
        this.#playbackRate = playbackRate
        this.#readPosition = offset
        this.#blockOffset = blockOffset
        if (this.#readPosition >= data.numberOfFrames) {
            this.#state = VoiceState.Done
            this.#fadeDirection = 0.0
        } else if (offset === 0) {
            this.#state = VoiceState.Active
            this.#fadeDirection = 0.0
        } else {
            this.#state = VoiceState.Fading
            this.#fadeDirection = 1.0
        }
    }

    get readPosition(): number {return this.#readPosition}

    done(): boolean {return this.#state === VoiceState.Done}
    isFadingOut(): boolean {return this.#state === VoiceState.Fading && this.#fadeDirection < 0}

    startFadeOut(blockOffset: int): void {
        if (this.#state !== VoiceState.Done && !(this.#state === VoiceState.Fading && this.#fadeDirection < 0)) {
            this.#state = VoiceState.Fading
            this.#fadeDirection = -1.0
            this.#fadeProgress = 0.0
            this.#fadeOutBlockOffset = blockOffset
        }
    }

    setPlaybackRate(rate: number): void {
        this.#playbackRate = rate
    }

    process(bufferStart: int, bufferCount: int): void {
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        const fadeLength = this.#fadeLength
        const playbackRate = this.#playbackRate
        const fadeOutThreshold = numberOfFrames - fadeLength * playbackRate
        const blockOffset = this.#blockOffset
        const fadeOutBlockOffset = this.#fadeOutBlockOffset
        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let readPosition = this.#readPosition
        let fadeProgress = this.#fadeProgress
        for (let i = 0; i < bufferCount; i++) {
            if (state === VoiceState.Done) {break}
            // Skip samples until we reach the block offset where this voice should start
            if (i < blockOffset) {continue}
            const j = bufferStart + i
            let amplitude: number
            if (state === VoiceState.Fading && fadeDirection > 0) {
                // Fading in
                amplitude = fadeProgress / fadeLength
                if (++fadeProgress >= fadeLength) {
                    state = VoiceState.Active
                    fadeProgress = 0.0
                    fadeDirection = 0.0
                }
            } else if (state === VoiceState.Fading && fadeDirection < 0) {
                // Fading out - wait for fadeOutBlockOffset
                if (i < fadeOutBlockOffset) {
                    amplitude = 1.0
                } else {
                    amplitude = 1.0 - fadeProgress / fadeLength
                    if (++fadeProgress >= fadeLength) {
                        state = VoiceState.Done
                        break
                    }
                }
            } else {
                amplitude = 1.0
            }
            const readInt = readPosition | 0
            if (readInt >= 0 && readInt < numberOfFrames - 1) {
                const alpha = readPosition - readInt
                const sL = framesL[readInt]
                const sR = framesR[readInt]
                outL[j] += (sL + alpha * (framesL[readInt + 1] - sL)) * amplitude
                outR[j] += (sR + alpha * (framesR[readInt + 1] - sR)) * amplitude
            }
            readPosition += playbackRate
            if (state === VoiceState.Active && readPosition >= fadeOutThreshold) {
                state = VoiceState.Fading
                fadeDirection = -1.0
                fadeProgress = 0.0
            }
        }
        this.#state = state
        this.#fadeDirection = fadeDirection
        this.#readPosition = readPosition
        this.#fadeProgress = fadeProgress
        this.#blockOffset = 0
        this.#fadeOutBlockOffset = 0
    }
}