import {int} from "@opendaw/lib-std"
import {AudioBuffer, AudioData} from "@opendaw/lib-dsp"
import {VoiceState} from "./VoiceState"
import {VOICE_FADE_DURATION} from "./constants"

/**
 * DirectVoice plays audio at the original speed (100%) without any time-stretching or pitch-shifting.
 */
export class DirectVoice {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #fadeLength: number

    #state: VoiceState
    #fadeDirection: number
    #readPosition: int
    #fadeProgress: number = 0.0
    #blockOffset: int
    #fadeOutBlockOffset: int = 0

    constructor(output: AudioBuffer, data: AudioData, offset: int = 0,
                blockOffset: int = 0) {
        this.#output = output
        this.#data = data
        this.#fadeLength = Math.round(VOICE_FADE_DURATION * sampleRate)
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

    get readPosition(): int {return this.#readPosition}

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

    process(bufferStart: int, bufferCount: int): void {
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        const fadeLength = this.#fadeLength
        const fadeOutThreshold = numberOfFrames - fadeLength
        const blockOffset = this.#blockOffset
        const fadeOutBlockOffset = this.#fadeOutBlockOffset
        let state = this.#state as VoiceState
        let fadeDirection = this.#fadeDirection
        let readPosition = this.#readPosition
        let fadeProgress = this.#fadeProgress
        for (let i = 0; i < bufferCount; i++) {
            if (state === VoiceState.Done) {break}
            if (i < blockOffset) {continue}
            const j = bufferStart + i
            let amplitude: number
            if (state === VoiceState.Fading && fadeDirection > 0) {
                amplitude = fadeProgress / fadeLength
                if (++fadeProgress >= fadeLength) {
                    state = VoiceState.Active
                    fadeProgress = 0.0
                    fadeDirection = 0.0
                }
            } else if (state === VoiceState.Fading && fadeDirection < 0) {
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
            if (readPosition >= 0 && readPosition < numberOfFrames) {
                outL[j] += framesL[readPosition] * amplitude
                outR[j] += framesR[readPosition] * amplitude
            }
            readPosition++
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
