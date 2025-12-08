import {int, Nullable} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, EventCollection} from "@opendaw/lib-dsp"
import {TransientMarkerBoxAdapter, WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {Voice} from "./Voice"
import {OnceVoice} from "./OnceVoice"
import {RepeatVoice} from "./RepeatVoice"
import {PingpongVoice} from "./PingpongVoice"
import {LOOP_MARGIN_START, LOOP_MARGIN_END, VOICE_FADE_DURATION} from "./constants"

/**
 * TimeStretchSequencer manages voice lifecycle for time-stretch playback.
 *
 * Responsibilities:
 * - Track current transient index
 * - Calculate when to spawn new voices (sample-exact)
 * - Calculate when to fade out voices (sample-exact)
 * - Handle tempo changes and discontinuities
 *
 * The sequencer is "smart" - it controls all timing decisions.
 * Voices are "dumb" - they only play audio on command.
 *
 * @see PLAYBACK_SYSTEM.md
 */
export class TimeStretchSequencer {
    readonly #output: AudioBuffer
    readonly #data: AudioData
    readonly #transients: EventCollection<TransientMarkerBoxAdapter>
    readonly #warpMarkers: EventCollection<WarpMarkerBoxAdapter>
    readonly #transientPlayMode: TransientPlayMode
    readonly #playbackRate: number
    readonly #waveformOffset: number

    #voices: Array<Voice> = []
    #currentTransientIndex: int = -1

    /**
     * @param output Output buffer to render into
     * @param data Audio data source
     * @param transients Collection of transient markers (positions in file seconds)
     * @param warpMarkers Collection of warp markers for time conversion
     * @param transientPlayMode How to handle transients (Once, Repeat, Pingpong)
     * @param playbackRate Rate of playback (1.0 = original pitch)
     * @param waveformOffset Offset into waveform in seconds
     */
    constructor(
        output: AudioBuffer,
        data: AudioData,
        transients: EventCollection<TransientMarkerBoxAdapter>,
        warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
        transientPlayMode: TransientPlayMode,
        playbackRate: number,
        waveformOffset: number
    ) {
        this.#output = output
        this.#data = data
        this.#transients = transients
        this.#warpMarkers = warpMarkers
        this.#transientPlayMode = transientPlayMode
        this.#playbackRate = playbackRate
        this.#waveformOffset = waveformOffset
    }

    /**
     * Reset sequencer state. Called on discontinuity.
     */
    reset(): void {
        for (const voice of this.#voices) {
            voice.startFadeOut(0)
        }
        this.#currentTransientIndex = -1
    }

    /**
     * Process a time-stretch block.
     *
     * @param _fileSecondsStart File position at start of block (in seconds) - reserved for future use
     * @param fileSecondsEnd File position at end of block (in seconds)
     * @param contentPpqn PPQN position within the content
     * @param pn PPQN duration of the block
     * @param bufferStart Start position in output buffer
     * @param bufferCount Number of samples to process
     */
    process(
        _fileSecondsStart: number,
        fileSecondsEnd: number,
        contentPpqn: number,
        pn: number,
        bufferStart: int,
        bufferCount: int
    ): void {
        const transients = this.#transients
        const data = this.#data
        const waveformOffset = this.#waveformOffset

        // Find transient index at current file position
        // Note: _fileSecondsStart is available for future drift detection enhancements
        const transientIndexAtEnd = transients.floorLastIndex(fileSecondsEnd)

        // Detect loop restart: if we're now at a lower transient index than before
        if (transientIndexAtEnd < this.#currentTransientIndex) {
            this.reset()
        }

        // Process if we'll cross into a new transient during this block
        if (transientIndexAtEnd !== this.#currentTransientIndex && transientIndexAtEnd >= 0) {
            const nextTransientIndex = this.#currentTransientIndex === -1
                ? transientIndexAtEnd
                : this.#currentTransientIndex + 1

            const nextTransient = transients.optAt(nextTransientIndex)
            if (nextTransient !== null) {
                const segmentInfo = this.#getSegmentInfo(nextTransientIndex)
                if (segmentInfo !== null) {
                    const {startSamples, endSamples, hasNext, nextTransientSeconds} = segmentInfo
                    const segmentLength = endSamples - startSamples
                    const minSegmentLength = (LOOP_MARGIN_START + LOOP_MARGIN_END) * data.sampleRate * 2

                    if (segmentLength >= minSegmentLength) {
                        // Calculate blockOffset: where in the output buffer does this transient start?
                        const transientWarpSeconds = nextTransient.position - waveformOffset
                        const transientPpqn = this.#secondsToPpqn(transientWarpSeconds)
                        const ppqnIntoBlock = transientPpqn - contentPpqn
                        const blockOffset = Math.max(0, Math.min(bufferCount - 1,
                            Math.round((ppqnIntoBlock / pn) * bufferCount)))

                        // D13: Drift detection for near-100% playback-speed
                        // If current voice is close to where we expect to be, let it continue
                        // to avoid unnecessary crossfades that cause phasing artifacts.
                        // Only spawn new voice when drift exceeds threshold.
                        const driftThresholdSamples = VOICE_FADE_DURATION * data.sampleRate
                        const shouldContinue = this.#voices.length > 0 && this.#voices.some(voice => {
                            if (voice.done()) return false
                            const drift = Math.abs(voice.readPosition() - startSamples)
                            return drift < driftThresholdSamples
                        })

                        if (shouldContinue) {
                            // Voice continues into next transient - update its segment end
                            for (const voice of this.#voices) {
                                if (!voice.done()) {
                                    voice.setSegmentEnd(endSamples)
                                }
                            }
                        } else {
                            // Fade out current voices
                            for (const voice of this.#voices) {
                                voice.startFadeOut(blockOffset)
                            }

                            // Calculate if looping is needed
                            // At playbackRate != 1.0, we consume audio samples at a different rate
                            // playbackRate < 1.0 (slower/lower pitch): consume fewer samples per output sample → more likely to need looping
                            // playbackRate > 1.0 (faster/higher pitch): consume more samples per output sample → less likely to need looping
                            let canLoop = false
                            if (hasNext && this.#transientPlayMode !== TransientPlayMode.Once) {
                                const nextNextWarpSeconds = nextTransientSeconds - waveformOffset
                                const nextNextPpqn = this.#secondsToPpqn(nextNextWarpSeconds)
                                const lastWarp = this.#warpMarkers.last()
                                const endPpqn = nextNextPpqn > transientPpqn && lastWarp !== null
                                    ? nextNextPpqn
                                    : (lastWarp?.position ?? transientPpqn)
                                const ppqnUntilNext = endPpqn - transientPpqn
                                const samplesPerPpqn = bufferCount / pn
                                const outputSamplesNeeded = ppqnUntilNext * samplesPerPpqn
                                // Audio samples consumed = output samples * playbackRate
                                const audioSamplesNeeded = outputSamplesNeeded * this.#playbackRate
                                const loopRegionLength = segmentLength -
                                    (LOOP_MARGIN_START + LOOP_MARGIN_END) * data.sampleRate
                                canLoop = audioSamplesNeeded > segmentLength * 1.01 && loopRegionLength > 0
                            }

                            // Spawn new voice based on TransientPlayMode (D15)
                            const newVoice = this.#createVoice(startSamples, endSamples, blockOffset, canLoop)
                            if (newVoice !== null) {
                                this.#voices.push(newVoice)
                            }
                        }
                    }
                    this.#currentTransientIndex = nextTransientIndex
                }
            }
        }

        // Check if any voice will reach its segment end during this block and trigger fade-out
        for (const voice of this.#voices) {
            if (!voice.done()) {
                const readPos = voice.readPosition()
                const segEnd = voice.segmentEnd()
                if (readPos >= segEnd) {
                    // Already past segment end - fade out immediately
                    voice.startFadeOut(0)
                } else {
                    // Check if we'll reach segment end during this block
                    const samplesUntilEnd = segEnd - readPos
                    const samplesThisBlock = bufferCount * this.#playbackRate
                    if (samplesUntilEnd <= samplesThisBlock) {
                        // Calculate exact blockOffset where we hit segment end
                        const blockOffset = Math.round(samplesUntilEnd / this.#playbackRate)
                        voice.startFadeOut(blockOffset)
                    }
                }
            }
        }

        // Process all voices
        for (const voice of this.#voices) {
            voice.process(bufferStart, bufferCount)
        }

        // Remove done voices
        this.#voices = this.#voices.filter(voice => !voice.done())
    }

    /**
     * Get segment info for a transient index.
     */
    #getSegmentInfo(index: int): Nullable<{
        startSamples: number
        endSamples: number
        hasNext: boolean
        nextTransientSeconds: number
    }> {
        const current = this.#transients.optAt(index)
        if (current === null) {
            return null
        }

        const next = this.#transients.optAt(index + 1)
        const startSamples = current.position * this.#data.sampleRate
        const endSamples = next !== null
            ? next.position * this.#data.sampleRate
            : this.#data.numberOfFrames

        return {
            startSamples,
            endSamples,
            hasNext: next !== null,
            nextTransientSeconds: next !== null ? next.position : Number.POSITIVE_INFINITY
        }
    }

    /**
     * Convert file seconds to PPQN using warp markers.
     */
    #secondsToPpqn(seconds: number): number {
        const warpMarkers = this.#warpMarkers
        for (let i = 0; i < warpMarkers.length() - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (left === null || right === null) {continue}
            if (seconds >= left.seconds && seconds < right.seconds) {
                const alpha = (seconds - left.seconds) / (right.seconds - left.seconds)
                return left.position + alpha * (right.position - left.position)
            }
        }
        return 0.0
    }

    /**
     * Create appropriate voice based on TransientPlayMode (D15).
     */
    #createVoice(startSamples: number, endSamples: number, blockOffset: int, canLoop: boolean): Nullable<Voice> {
        if (startSamples >= endSamples) {
            return null
        }

        const transientPlayMode = this.#transientPlayMode
        const playbackRate = this.#playbackRate
        const sampleRate = this.#data.sampleRate

        if (transientPlayMode === TransientPlayMode.Once || !canLoop) {
            return new OnceVoice(
                this.#output,
                this.#data,
                startSamples,
                endSamples,
                playbackRate,
                blockOffset,
                sampleRate
            )
        } else if (transientPlayMode === TransientPlayMode.Repeat) {
            return new RepeatVoice(
                this.#output,
                this.#data,
                startSamples,
                endSamples,
                playbackRate,
                blockOffset,
                sampleRate
            )
        } else {
            return new PingpongVoice(
                this.#output,
                this.#data,
                startSamples,
                endSamples,
                playbackRate,
                blockOffset,
                sampleRate
            )
        }
    }

    /**
     * Get current voices (for external management).
     */
    get voices(): Array<Voice> {
        return this.#voices
    }

    /**
     * Set voices (for external management when sharing with pitch mode).
     */
    set voices(v: Array<Voice>) {
        this.#voices = v
    }

    /**
     * Get current transient index.
     */
    get currentTransientIndex(): int {
        return this.#currentTransientIndex
    }

    /**
     * Set current transient index (for external management).
     */
    set currentTransientIndex(index: int) {
        this.#currentTransientIndex = index
    }
}
