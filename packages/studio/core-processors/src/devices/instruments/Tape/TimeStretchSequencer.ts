import {int, Nullable} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, EventCollection, TempoMap} from "@opendaw/lib-dsp"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {Voice} from "./Voice"
import {OnceVoice} from "./OnceVoice"
import {RepeatVoice} from "./RepeatVoice"
import {PingpongVoice} from "./PingpongVoice"
import {VOICE_FADE_DURATION} from "./constants"

/** Minimal transient marker interface for sequencer */
export interface TransientMarker {
    readonly type: string
    readonly position: number // file seconds
}

/** Minimal warp marker interface for sequencer */
export interface WarpMarker {
    readonly type: string
    readonly position: number // PPQN
    readonly seconds: number  // file seconds
}

/**
 * TimeStretchSequencer manages voice lifecycle for time-stretch playback.
 */
export class TimeStretchSequencer {
    #voices: Array<Voice> = []
    #currentTransientIndex: int = -1
    #accumulatedDrift: number = 0.0

    reset(): void {
        for (const voice of this.#voices) {
            voice.startFadeOut(0)
        }
        this.#currentTransientIndex = -1
        this.#accumulatedDrift = 0.0
    }

    process(
        output: AudioBuffer,
        data: AudioData,
        transients: EventCollection<TransientMarker>,
        warpMarkers: EventCollection<WarpMarker>,
        transientPlayMode: TransientPlayMode,
        playbackRate: number,
        waveformOffset: number,
        tempoMap: TempoMap,
        fileSecondsEnd: number,
        contentPpqn: number,
        pn: number,
        bufferStart: int,
        bufferCount: int
    ): void {
        const sampleRate = data.sampleRate
        const transientIndexAtEnd = transients.floorLastIndex(fileSecondsEnd)

        // Detect loop restart
        if (transientIndexAtEnd < this.#currentTransientIndex) {
            this.reset()
        }

        // Check if crossing into new transient
        if (transientIndexAtEnd !== this.#currentTransientIndex && transientIndexAtEnd >= 0) {
            const nextTransientIndex = this.#currentTransientIndex === -1
                ? transientIndexAtEnd
                : this.#currentTransientIndex + 1

            const nextTransient = transients.optAt(nextTransientIndex)
            if (nextTransient !== null) {
                this.#handleTransientBoundary(
                    output, data, transients, warpMarkers, transientPlayMode,
                    playbackRate, waveformOffset, tempoMap, nextTransientIndex,
                    nextTransient.position, contentPpqn, pn, bufferCount, sampleRate
                )
                this.#currentTransientIndex = nextTransientIndex
            }
        }

        // Check if OnceVoice reached segment end (looping voices handle their own looping)
        for (const voice of this.#voices) {
            if (!voice.done() && voice instanceof OnceVoice) {
                const readPos = voice.readPosition()
                const segEnd = voice.segmentEnd()
                if (readPos >= segEnd) {
                    voice.startFadeOut(0)
                } else {
                    const samplesUntilEnd = (segEnd - readPos) / playbackRate
                    if (samplesUntilEnd <= bufferCount) {
                        voice.startFadeOut(Math.max(0, Math.round(samplesUntilEnd)))
                    }
                }
            }
        }

        // Process and cleanup
        for (const voice of this.#voices) {
            voice.process(bufferStart, bufferCount)
        }
        this.#voices = this.#voices.filter(voice => !voice.done())
    }

    #handleTransientBoundary(
        output: AudioBuffer,
        data: AudioData,
        transients: EventCollection<TransientMarker>,
        warpMarkers: EventCollection<WarpMarker>,
        transientPlayMode: TransientPlayMode,
        playbackRate: number,
        waveformOffset: number,
        tempoMap: TempoMap,
        transientIndex: int,
        transientFileSeconds: number,
        contentPpqn: number,
        pn: number,
        bufferCount: int,
        sampleRate: number
    ): void {
        const segmentInfo = this.#getSegmentInfo(transients, transientIndex, data)
        if (segmentInfo === null) return

        const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
        const segmentLengthSamples = endSamples - startSamples

        // Calculate block offset
        const transientWarpSeconds = transientFileSeconds - waveformOffset
        const transientPpqn = this.#secondsToPpqn(transientWarpSeconds, warpMarkers)
        const ppqnIntoBlock = transientPpqn - contentPpqn
        const blockOffset = Math.max(0, Math.min(bufferCount - 1,
            Math.round((ppqnIntoBlock / pn) * bufferCount)))

        // Calculate output samples until next transient
        let outputSamplesUntilNext: number
        if (hasNext) {
            const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
            const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
            const secondsUntilNext = tempoMap.intervalToSeconds(transientPpqn, nextPpqn)
            outputSamplesUntilNext = secondsUntilNext * sampleRate
        } else {
            outputSamplesUntilNext = Number.POSITIVE_INFINITY
        }

        const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
        const driftThreshold = VOICE_FADE_DURATION * sampleRate
        let shouldContinueVoice = false

        // Drift detection
        for (const voice of this.#voices) {
            if (voice.done()) continue
            const drift = voice.readPosition() - startSamples

            if (Math.abs(drift) < driftThreshold) {
                this.#accumulatedDrift += drift
                if (Math.abs(this.#accumulatedDrift) < driftThreshold) {
                    shouldContinueVoice = true
                    voice.setSegmentEnd(endSamples)
                } else {
                    this.#accumulatedDrift = 0.0
                }
                break
            }
        }

        if (shouldContinueVoice) return

        // Fade out and spawn new voice
        for (const voice of this.#voices) {
            voice.startFadeOut(blockOffset)
        }

        // Check if we're close to 1:1 speed ratio (within 1%)
        // If so, avoid looping to prevent phase artifacts
        const speedRatio = segmentLengthSamples / audioSamplesNeeded
        const closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01
        const needsLooping = !closeToUnity && audioSamplesNeeded > segmentLengthSamples

        const newVoice = this.#createVoice(
            output, data, startSamples, endSamples,
            playbackRate, blockOffset, sampleRate,
            transientPlayMode, needsLooping
        )

        if (newVoice !== null) {
            this.#voices.push(newVoice)
        }
        this.#accumulatedDrift = 0.0
    }

    #getSegmentInfo(
        transients: EventCollection<TransientMarker>,
        index: int,
        data: AudioData
    ): Nullable<{startSamples: number, endSamples: number, hasNext: boolean, nextTransientFileSeconds: number}> {
        const current = transients.optAt(index)
        if (current === null) return null

        const next = transients.optAt(index + 1)
        return {
            startSamples: current.position * data.sampleRate,
            endSamples: next !== null ? next.position * data.sampleRate : data.numberOfFrames,
            hasNext: next !== null,
            nextTransientFileSeconds: next !== null ? next.position : Number.POSITIVE_INFINITY
        }
    }

    #secondsToPpqn(seconds: number, warpMarkers: EventCollection<WarpMarker>): number {
        for (let i = 0; i < warpMarkers.length() - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (left === null || right === null) continue
            if (seconds >= left.seconds && seconds < right.seconds) {
                const alpha = (seconds - left.seconds) / (right.seconds - left.seconds)
                return left.position + alpha * (right.position - left.position)
            }
        }
        return 0.0
    }

    #createVoice(
        output: AudioBuffer,
        data: AudioData,
        startSamples: number,
        endSamples: number,
        playbackRate: number,
        blockOffset: int,
        sampleRate: number,
        transientPlayMode: TransientPlayMode,
        needsLooping: boolean
    ): Nullable<Voice> {
        if (startSamples >= endSamples) return null

        if (transientPlayMode === TransientPlayMode.Once || !needsLooping) {
            return new OnceVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
        }
        if (transientPlayMode === TransientPlayMode.Repeat) {
            return new RepeatVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
        }
        return new PingpongVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
    }

    get voices(): Array<Voice> {return this.#voices}
    set voices(v: Array<Voice>) {this.#voices = v}
}
