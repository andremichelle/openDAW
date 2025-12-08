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
 * TimeStretchSequencer manages voice lifecycle for time-stretch playback.
 * All timing computations happen here - the processor just passes data.
 */
export class TimeStretchSequencer {
    readonly #voices: Array<Voice> = []
    #currentTransientIndex: int = -1
    #accumulatedDrift: number = 0.0

    get voiceCount(): number {
        return this.#voices.length
    }

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
        transients: EventCollection<TransientMarkerBoxAdapter>,
        config: AudioTimeStretchBoxAdapter,
        waveformOffset: number,
        block: Block,
        cycle: LoopableRegion.LoopCycle
    ): void {
        const {p0, p1, s0, s1, bpm, flags} = block

        // Debug: log every process call
        // console.log(`[SEQ] process: voices=${this.#voices.length}, transientIdx=${this.#currentTransientIndex}, bpm=${bpm}, p0=${p0.toFixed(2)}`)
        const warpMarkers = config.warpMarkers
        const transientPlayMode = config.transientPlayMode
        const playbackRate = config.playbackRate
        const {sampleRate, numberOfFrames} = data
        const fileDurationSeconds = numberOfFrames / sampleRate

        // Handle discontinuity
        if (Bits.some(flags, BlockFlag.discontinuous)) {
            this.reset()
        }

        // Compute buffer positions from cycle
        const sn = s1 - s0
        const pn = p1 - p0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bufferStart = (s0 + sn * r0) | 0
        const bufferEnd = (s0 + sn * r1) | 0
        const bufferCount = bufferEnd - bufferStart

        // Validate warp markers
        const firstWarp = warpMarkers.first()
        const lastWarp = warpMarkers.last()
        if (firstWarp === null || lastWarp === null) return

        // Compute content position in PPQN
        const contentPpqn = cycle.resultStart - cycle.rawStart
        if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) return

        // Compute file position at block end for transient detection
        const contentPpqnEnd = contentPpqn + pn
        const warpSecondsEnd = this.#ppqnToSeconds(contentPpqnEnd, warpMarkers)
        if (warpSecondsEnd === null) return
        const fileSecondsEnd = warpSecondsEnd + waveformOffset

        // Clamp to valid file range
        if (fileSecondsEnd < 0.0 || fileSecondsEnd >= fileDurationSeconds) return

        const transientIndexAtEnd = transients.floorLastIndex(fileSecondsEnd)

        // Detect loop restart
        if (transientIndexAtEnd < this.#currentTransientIndex) {
            this.reset()
        }

        // Check if crossing into new transient
        if (transientIndexAtEnd !== this.#currentTransientIndex && transientIndexAtEnd >= 0) {
            const transient = transients.optAt(transientIndexAtEnd)
            if (transient !== null) {
                this.#handleTransientBoundary(
                    output, data, transients, warpMarkers, transientPlayMode, playbackRate,
                    waveformOffset, bpm, sampleRate, transientIndexAtEnd, transient.position,
                    contentPpqn, pn, bufferCount
                )
                this.#currentTransientIndex = transientIndexAtEnd
            }
        }


        // AFTER transient handling (which may extend segmentEnd via drift detection):
        // Check if OnceVoice will exhaust its segment audio during this block
        // If BPM changed and now needs looping, spawn a looping voice mid-segment
        // Calculate sample-exact fade-out offset (sequencer decides, not voice, because BPM can change)
        for (const voice of this.#voices) {
            if (voice instanceof OnceVoice && !voice.done()) {
                const readPos = voice.readPosition()
                const segEnd = voice.segmentEnd()
                if (readPos < segEnd) {
                    // Calculate how many samples until we hit segmentEnd
                    const samplesToEnd = (segEnd - readPos) / playbackRate
                    if (samplesToEnd < bufferCount) {
                        // Will cross segmentEnd during this block
                        // Check if we now need looping due to BPM change
                        const segmentInfo = this.#getSegmentInfo(transients, this.#currentTransientIndex, data)
                        if (segmentInfo !== null && transientPlayMode !== TransientPlayMode.Once) {
                            const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
                            const segmentLengthSamples = endSamples - startSamples

                            // Calculate current needsLooping based on current BPM
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
                                // BPM changed - now needs looping! Fade out OnceVoice and spawn looping voice
                                const fadeOutOffset = Math.max(0, Math.floor(samplesToEnd))
                                voice.startFadeOut(fadeOutOffset)

                                // Spawn looping voice at the segment start, computing position as if started from beginning
                                // The new voice will start at the position where OnceVoice currently is
                                const newVoice = this.#createVoice(
                                    output, data, startSamples, endSamples,
                                    playbackRate, fadeOutOffset, sampleRate,
                                    transientPlayMode, true // force looping
                                )
                                if (newVoice !== null) {
                                    this.#voices.push(newVoice)
                                }
                                continue
                            }
                        }

                        // No looping needed - just fade out at exact sample
                        const fadeOutOffset = Math.max(0, Math.floor(samplesToEnd))
                        voice.startFadeOut(fadeOutOffset)
                    }
                } else {
                    // Already past segmentEnd - fade out immediately
                    voice.startFadeOut(0)
                }
            }
        }

        // Process all voices
        for (const voice of this.#voices) {
            voice.process(bufferStart, bufferCount)
        }

        // Cleanup done voices
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].done()) {
                // console.log(`[SEQ] Removing done voice: ${this.#voices[i].constructor.name}`)
                this.#voices.splice(i, 1)
            }
        }

        // Debug: warn if voice count is abnormal
        if (this.#voices.length > 2) {
            console.warn(`[SEQ] WARNING: ${this.#voices.length} voices active!`)
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
        contentPpqn: number,
        pn: number,
        bufferCount: int
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

        // Calculate output samples until next transient using block's BPM
        let outputSamplesUntilNext: number
        if (hasNext) {
            const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
            const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
            const ppqnDelta = nextPpqn - transientPpqn
            const secondsUntilNext = PPQN.pulsesToSeconds(ppqnDelta, bpm)
            outputSamplesUntilNext = secondsUntilNext * sampleRate
        } else {
            outputSamplesUntilNext = Number.POSITIVE_INFINITY
        }

        const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
        const driftThreshold = VOICE_FADE_DURATION * sampleRate
        let shouldContinueVoice = false

        // Drift detection - only for OnceVoice at near-matching speed
        // Looping voices always get replaced at transient boundaries
        let continuedVoice: Voice | null = null
        for (const voice of this.#voices) {
            if (voice.done()) continue

            // Only OnceVoice can continue via drift detection
            if (!(voice instanceof OnceVoice)) continue

            const readPos = voice.readPosition()
            const drift = readPos - startSamples

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
            // Fade out all other voices to ensure only one plays
            for (const voice of this.#voices) {
                if (voice !== continuedVoice && !voice.done()) {
                    voice.startFadeOut(blockOffset)
                }
            }
            return
        }

        // Fade out ALL existing voices
        const voicesToFadeOut = this.#voices.filter(v => !v.done()).length
        for (const voice of this.#voices) {
            if (!voice.done()) {
                voice.startFadeOut(blockOffset)
            }
        }

        if (voicesToFadeOut > 1) {
            console.warn(`[SEQ] Fading out ${voicesToFadeOut} voices at transient ${transientIndex}`)
        }

        // Determine if looping is needed based on current BPM
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
        transients: EventCollection<TransientMarkerBoxAdapter>,
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
}
