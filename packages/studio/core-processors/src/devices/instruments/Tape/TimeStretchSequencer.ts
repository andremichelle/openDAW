import {Bits, int, Nullable} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, EventCollection, LoopableRegion, PPQN} from "@opendaw/lib-dsp"
import {AudioTimeStretchBoxAdapter, TransientMarkerBoxAdapter, WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {Block, BlockFlag} from "../../../processing"
import {Voice} from "./Voice"
import {OnceVoice} from "./OnceVoice"
import {RepeatVoice} from "./RepeatVoice"
import {PingpongVoice} from "./PingpongVoice"
import {VOICE_FADE_DURATION} from "./constants"
import {TransientPlayMode} from "@opendaw/studio-enums"

/**
 * TimeStretchSequencer orchestrates transient-based granular playback.
 *
 * ## Key Concept: Shifted Transient Boundaries
 *
 * To preserve transient attacks, we shift the voice spawn point earlier by VOICE_FADE_DURATION.
 * This means:
 * - Voice starts fading in at (transient - VOICE_FADE_DURATION)
 * - Fade completes exactly when the real transient occurs
 * - The transient attack is heard at full amplitude
 *
 * Exception: First transient (index 0) is NOT shifted - no fade-in needed at file start.
 */
export class TimeStretchSequencer {
    readonly #voices: Array<Voice> = []

    #currentTransientIndex: int = -1
    #accumulatedDrift: number = 0.0

    constructor() {}

    get voiceCount(): number {return this.#voices.length}

    reset(): void {
        for (const voice of this.#voices) {
            voice.startFadeOut(0)
        }
        this.#currentTransientIndex = -1
        this.#accumulatedDrift = 0.0
    }

    process(output: AudioBuffer,
            data: AudioData,
            transients: EventCollection<TransientMarkerBoxAdapter>,
            config: AudioTimeStretchBoxAdapter,
            waveformOffset: number,
            block: Block,
            cycle: LoopableRegion.LoopCycle): void {
        const {p0, p1, bpm, flags} = block

        const warpMarkers = config.warpMarkers
        const transientPlayMode = config.transientPlayMode
        const playbackRate = config.playbackRate
        const {sampleRate, numberOfFrames} = data
        const fileDurationSeconds = numberOfFrames / sampleRate
        if (Bits.some(flags, BlockFlag.discontinuous)) {this.reset()}
        const pn = p1 - p0
        const s0 = block.s0
        const s1 = block.s1
        const sn = s1 - s0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bufferStart = (s0 + sn * r0) | 0
        const bufferEnd = (s0 + sn * r1) | 0
        const bufferCount = bufferEnd - bufferStart
        const firstWarp = warpMarkers.first()
        const lastWarp = warpMarkers.last()
        if (firstWarp === null || lastWarp === null) return
        const contentPpqn = cycle.resultStart - cycle.rawStart
        if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) return
        const contentPpqnEnd = contentPpqn + pn
        const warpSecondsEnd = this.#ppqnToSeconds(contentPpqnEnd, warpMarkers)
        if (warpSecondsEnd === null) return
        const fileSecondsEnd = warpSecondsEnd + waveformOffset
        if (fileSecondsEnd < 0.0 || fileSecondsEnd >= fileDurationSeconds) return
        const warpSecondsStart = this.#ppqnToSeconds(contentPpqn, warpMarkers) ?? 0
        const fileSecondsSpan = warpSecondsEnd - warpSecondsStart
        const outputSecondsSpan = pn / (960 * bpm / 60)
        const fileToOutputRatio = outputSecondsSpan > 0 ? fileSecondsSpan / outputSecondsSpan : 1.0
        const transientShiftSeconds = VOICE_FADE_DURATION * fileToOutputRatio * playbackRate * (data.sampleRate / sampleRate)
        const shiftedFileSeconds = fileSecondsEnd + transientShiftSeconds
        const transientIndexShifted = transients.floorLastIndex(shiftedFileSeconds)
        if (transientIndexShifted < this.#currentTransientIndex) {this.reset()}
        if (transientIndexShifted > this.#currentTransientIndex && transientIndexShifted >= 0) {
            const transient = transients.optAt(transientIndexShifted)
            if (transient !== null) {
                const transientFileSeconds = transient.position
                // Since we detect transients early via lookahead, crossfade starts immediately
                // when we detect the transient (blockOffset=0). Both old the voice fade-out and
                // the new voice fade-in starts at the same time and complete at the actual transient.
                this.#handleTransientBoundary(
                    output, data, transients, warpMarkers, transientPlayMode, playbackRate,
                    waveformOffset, bpm, sampleRate, transientIndexShifted, transientFileSeconds,
                    bufferCount
                )
                this.#currentTransientIndex = transientIndexShifted
            }
        }

        for (const voice of this.#voices) {
            if (voice instanceof OnceVoice && !voice.done() && !voice.isFadingOut()) {
                const readPos = voice.readPosition()
                const segEnd = voice.segmentEnd()

                if (readPos >= segEnd) {
                    voice.startFadeOut(0)
                    continue
                }

                // Check if BPM changed and we now need looping
                if (transientPlayMode !== TransientPlayMode.Once) {
                    const segmentInfo = this.#getSegmentInfo(transients, this.#currentTransientIndex, data)
                    if (segmentInfo !== null) {
                        const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
                        const segmentLengthSamples = endSamples - startSamples

                        let outputSamplesUntilNext: number
                        if (hasNext) {
                            const currentTransient = transients.optAt(this.#currentTransientIndex)
                            if (currentTransient !== null) {
                                const transientWarpSeconds = currentTransient.position - waveformOffset
                                const transientPpqn = this.#secondsToPpqn(transientWarpSeconds, warpMarkers)
                                const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
                                const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
                                const ppqnDelta = nextPpqn - transientPpqn
                                const secondsUntilNext = PPQN.pulsesToSeconds(ppqnDelta, bpm)
                                outputSamplesUntilNext = secondsUntilNext * sampleRate
                            } else {
                                outputSamplesUntilNext = Number.POSITIVE_INFINITY
                            }
                        } else {
                            outputSamplesUntilNext = Number.POSITIVE_INFINITY
                        }

                        const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
                        const speedRatio = segmentLengthSamples / audioSamplesNeeded
                        const closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01
                        const needsLooping = !closeToUnity && audioSamplesNeeded > segmentLengthSamples

                        if (needsLooping) {
                            // Fade out OnceVoice and spawn looping voice at same position
                            voice.startFadeOut(0)
                            const newVoice = this.#createVoice(
                                output, data, startSamples, endSamples,
                                playbackRate, 0, sampleRate,
                                transientPlayMode, true,
                                readPos
                            )
                            if (newVoice !== null) {
                                this.#voices.push(newVoice)
                            }
                            continue
                        }
                    }
                }

                // Schedule fade-out before segment end
                const samplesToEnd = (segEnd - readPos) / playbackRate
                if (samplesToEnd < bufferCount) {
                    const fadeOutOffset = Math.max(0, Math.floor(samplesToEnd))
                    voice.startFadeOut(fadeOutOffset)
                }
            }
        }

        // Process all voices
        for (const voice of this.#voices) {
            voice.process(bufferStart, bufferCount)
        }

        // Remove done voices
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].done()) {
                this.#voices.splice(i, 1)
            }
        }
    }

    #handleTransientBoundary(
        output: AudioBuffer,
        data: AudioData,
        transients: EventCollection<TransientMarkerBoxAdapter>,
        warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
        transientPlayMode: TransientPlayMode,
        playbackRate: number,
        waveformOffset: number,
        bpm: number,
        sampleRate: number,
        transientIndex: int,
        transientFileSeconds: number,
        bufferCount: int
    ): void {
        const segmentInfo = this.#getSegmentInfo(transients, transientIndex, data)
        if (segmentInfo === null) return

        const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
        const segmentLengthSamples = endSamples - startSamples

        // Calculate output samples until next transient
        let outputSamplesUntilNext: number
        if (hasNext) {
            const transientWarpSeconds = transientFileSeconds - waveformOffset
            const transientPpqn = this.#secondsToPpqn(transientWarpSeconds, warpMarkers)
            const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
            const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
            const ppqnDelta = nextPpqn - transientPpqn
            const secondsUntilNext = PPQN.pulsesToSeconds(ppqnDelta, bpm)
            outputSamplesUntilNext = secondsUntilNext * sampleRate
        } else {
            outputSamplesUntilNext = Number.POSITIVE_INFINITY
        }

        const driftThreshold = VOICE_FADE_DURATION * sampleRate
        let shouldContinueVoice = false
        let continuedVoice: Voice | null = null

        // Check if an existing voice can continue (drift within threshold)
        // Because we detect transients early via lookahead, we need to project voice position
        // forward by the fade duration to get drift at actual transient time
        // This must match the transient shift formula: VOICE_FADE_DURATION * data.sampleRate * playbackRate
        const lookaheadSamples = VOICE_FADE_DURATION * data.sampleRate * playbackRate
        for (const voice of this.#voices) {
            if (voice.done()) continue
            if (!(voice instanceof OnceVoice)) continue

            const readPos = voice.readPosition()
            // Project voice position forward to where it will be at actual transient time
            const projectedReadPos = readPos + lookaheadSamples
            const drift = projectedReadPos - startSamples

            if (Math.abs(drift) < driftThreshold) {
                this.#accumulatedDrift += drift
                if (Math.abs(this.#accumulatedDrift) < driftThreshold) {
                    shouldContinueVoice = true
                    continuedVoice = voice
                    voice.setSegmentEnd(endSamples)
                } else {
                    this.#accumulatedDrift = 0.0
                }
                break
            }
        }

        if (shouldContinueVoice) {
            // Voice continues - fade out any other voices immediately
            for (const voice of this.#voices) {
                if (voice !== continuedVoice && !voice.done()) {
                    voice.startFadeOut(0)
                }
            }
            return
        }

        // Fade out all existing voices immediately (crossfade starts now due to lookahead)
        for (const voice of this.#voices) {
            if (!voice.done()) {
                voice.startFadeOut(0)
            }
        }

        // Determine if we need looping
        const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
        const speedRatio = segmentLengthSamples / audioSamplesNeeded
        const closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01
        const needsLooping = !closeToUnity && audioSamplesNeeded > segmentLengthSamples

        // Calculate voice start position:
        // - For transient index 0: start at transient (no fade-in needed at file start)
        // - For other transients: start BEFORE the transient so fade-in completes AT the transient
        //
        // During fade-in:
        // - Voice processes VOICE_FADE_DURATION * sampleRate output samples
        // - Voice reads at playbackRate, advancing playbackRate file samples per output sample
        // - Total file samples read = VOICE_FADE_DURATION * sampleRate * playbackRate
        //
        // Account for sample rate difference between output and file:
        // - fadeSamplesInFile = VOICE_FADE_DURATION * sampleRate * playbackRate * (data.sampleRate / sampleRate)
        // - Simplifies to: VOICE_FADE_DURATION * data.sampleRate * playbackRate
        const fadeSamplesInFile = VOICE_FADE_DURATION * data.sampleRate * playbackRate
        const voiceStartSamples = transientIndex === 0
            ? startSamples
            : Math.max(0, startSamples - fadeSamplesInFile)

        // Create new voice
        // For shifted voice start, use blockOffset=0 since we've already accounted for early start
        // by shifting voiceStartSamples back. The voice starts immediately at current block position.
        const newVoice = this.#createVoice(
            output, data, voiceStartSamples, endSamples,
            playbackRate, 0, sampleRate,
            transientPlayMode, needsLooping
        )

        if (newVoice !== null) {
            this.#voices.push(newVoice)
        }
        this.#accumulatedDrift = 0.0
    }

    #getSegmentInfo(
        transients: EventCollection<TransientMarkerBoxAdapter>,
        index: int,
        data: AudioData
    ): Nullable<{ startSamples: number, endSamples: number, hasNext: boolean, nextTransientFileSeconds: number }> {
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

    #ppqnToSeconds(ppqn: number, warpMarkers: EventCollection<WarpMarkerBoxAdapter>): Nullable<number> {
        for (let i = 0; i < warpMarkers.length() - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (left === null || right === null) continue
            if (ppqn >= left.position && ppqn < right.position) {
                const alpha = (ppqn - left.position) / (right.position - left.position)
                return left.seconds + alpha * (right.seconds - left.seconds)
            }
        }
        return null
    }

    #secondsToPpqn(seconds: number, warpMarkers: EventCollection<WarpMarkerBoxAdapter>): number {
        for (let i = 0; i < warpMarkers.length() - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (left === null || right === null) continue
            if (seconds >= left.seconds && seconds < right.seconds) {
                const alpha = (seconds - left.seconds) / (right.seconds - left.seconds)
                return left.position + alpha * (right.position - left.position)
            }
        }
        const last = warpMarkers.last()
        if (last !== null && seconds >= last.seconds) {
            return last.position
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
        needsLooping: boolean,
        initialReadPosition?: number
    ): Nullable<Voice> {
        if (startSamples >= endSamples) return null

        if (transientPlayMode === TransientPlayMode.Once || !needsLooping) {
            return new OnceVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
        }

        if (transientPlayMode === TransientPlayMode.Repeat) {
            return new RepeatVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate, initialReadPosition)
        }

        if (initialReadPosition !== undefined) {
            return new PingpongVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate, {
                position: initialReadPosition,
                direction: 1.0
            })
        }
        return new PingpongVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
    }
}
