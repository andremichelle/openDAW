import {Bits, int, isDefined, isNotNull, Nullable} from "@moises-ai/lib-std"
import {AudioBuffer, AudioData, EventCollection, LoopableRegion, PPQN} from "@moises-ai/lib-dsp"
import {AudioTimeStretchBoxAdapter, TransientMarkerBoxAdapter, WarpMarkerBoxAdapter} from "@moises-ai/studio-adapters"
import {Block, BlockFlag} from "../../../processing"
import {Voice} from "./Voice"
import {OnceVoice} from "./OnceVoice"
import {RepeatVoice} from "./RepeatVoice"
import {PingpongVoice} from "./PingpongVoice"
import {VOICE_FADE_DURATION} from "./constants"
import {TransientPlayMode} from "@moises-ai/studio-enums"

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
        if (!isNotNull(firstWarp) || !isNotNull(lastWarp)) {return}
        const contentPpqn = cycle.resultStart - cycle.rawStart
        if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) {return}
        const contentPpqnEnd = contentPpqn + pn
        const warpSecondsEnd = this.#ppqnToSeconds(contentPpqnEnd, warpMarkers)
        if (!isNotNull(warpSecondsEnd)) {return}
        const fileSecondsEnd = warpSecondsEnd + waveformOffset
        if (fileSecondsEnd < 0.0 || fileSecondsEnd >= fileDurationSeconds) {return}
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
            if (isNotNull(transient)) {
                this.#handleTransientBoundary(
                    output, data, transients, warpMarkers, transientPlayMode, playbackRate,
                    waveformOffset, bpm, sampleRate, transientIndexShifted, transient.position
                )
                this.#currentTransientIndex = transientIndexShifted
            }
        }
        for (const voice of this.#voices) {
            if (!(voice instanceof OnceVoice)) {continue}
            if (voice.done() || voice.isFadingOut()) {continue}
            const readPos = voice.readPosition()
            const segEnd = voice.segmentEnd()
            if (readPos >= segEnd) {
                voice.startFadeOut(0)
                continue
            }
            if (transientPlayMode !== TransientPlayMode.Once) {
                const segmentInfo = this.#getSegmentInfo(transients, this.#currentTransientIndex, data)
                if (isNotNull(segmentInfo)) {
                    const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
                    const segmentLengthSamples = endSamples - startSamples
                    let outputSamplesUntilNext: number = Number.POSITIVE_INFINITY
                    if (hasNext) {
                        const currentTransient = transients.optAt(this.#currentTransientIndex)
                        if (isNotNull(currentTransient)) {
                            const transientWarpSeconds = currentTransient.position - waveformOffset
                            const transientPpqn = this.#secondsToPpqn(transientWarpSeconds, warpMarkers)
                            const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
                            const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
                            const ppqnDelta = nextPpqn - transientPpqn
                            const secondsUntilNext = PPQN.pulsesToSeconds(ppqnDelta, bpm)
                            outputSamplesUntilNext = secondsUntilNext * sampleRate
                        }
                    }
                    const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
                    const speedRatio = segmentLengthSamples / audioSamplesNeeded
                    const closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01
                    const needsLooping = !closeToUnity && audioSamplesNeeded > segmentLengthSamples
                    if (needsLooping) {
                        voice.startFadeOut(0)
                        const newVoice = this.#createVoice(
                            output, data, startSamples, endSamples,
                            playbackRate, 0, sampleRate,
                            transientPlayMode, true, readPos
                        )
                        if (isNotNull(newVoice)) {this.#voices.push(newVoice)}
                        continue
                    }
                }
            }
            const samplesToEnd = (segEnd - readPos) / playbackRate
            if (samplesToEnd < bufferCount) {
                const fadeOutOffset = Math.max(0, Math.floor(samplesToEnd))
                voice.startFadeOut(fadeOutOffset)
            }
        }
        for (const voice of this.#voices) {
            voice.process(bufferStart, bufferCount)
        }
        for (let i = this.#voices.length - 1; i >= 0; i--) {
            if (this.#voices[i].done()) {this.#voices.splice(i, 1)}
        }
    }

    #handleTransientBoundary(output: AudioBuffer,
                             data: AudioData,
                             transients: EventCollection<TransientMarkerBoxAdapter>,
                             warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
                             transientPlayMode: TransientPlayMode,
                             playbackRate: number,
                             waveformOffset: number,
                             bpm: number,
                             sampleRate: number,
                             transientIndex: int,
                             transientFileSeconds: number): void {
        const segmentInfo = this.#getSegmentInfo(transients, transientIndex, data)
        if (!isNotNull(segmentInfo)) {return}
        const {startSamples, endSamples, hasNext, nextTransientFileSeconds} = segmentInfo
        const segmentLengthSamples = endSamples - startSamples
        let outputSamplesUntilNext: number = Number.POSITIVE_INFINITY
        if (hasNext) {
            const transientWarpSeconds = transientFileSeconds - waveformOffset
            const transientPpqn = this.#secondsToPpqn(transientWarpSeconds, warpMarkers)
            const nextWarpSeconds = nextTransientFileSeconds - waveformOffset
            const nextPpqn = this.#secondsToPpqn(nextWarpSeconds, warpMarkers)
            const ppqnDelta = nextPpqn - transientPpqn
            const secondsUntilNext = PPQN.pulsesToSeconds(ppqnDelta, bpm)
            outputSamplesUntilNext = secondsUntilNext * sampleRate
        }
        const driftThreshold = VOICE_FADE_DURATION * sampleRate
        const lookaheadSamples = VOICE_FADE_DURATION * data.sampleRate * playbackRate
        let continuedVoice: Nullable<Voice> = null
        for (const voice of this.#voices) {
            if (voice.done()) {continue}
            if (!(voice instanceof OnceVoice)) {continue}
            const projectedReadPos = voice.readPosition() + lookaheadSamples
            const drift = projectedReadPos - startSamples
            if (Math.abs(drift) >= driftThreshold) {continue}
            this.#accumulatedDrift += drift
            if (Math.abs(this.#accumulatedDrift) < driftThreshold) {
                continuedVoice = voice
                voice.setSegmentEnd(endSamples)
            } else {
                this.#accumulatedDrift = 0.0
            }
            break
        }
        if (isNotNull(continuedVoice)) {
            for (const voice of this.#voices) {
                if (voice !== continuedVoice && !voice.done()) {voice.startFadeOut(0)}
            }
            return
        }
        for (const voice of this.#voices) {
            if (!voice.done()) {voice.startFadeOut(0)}
        }
        const audioSamplesNeeded = outputSamplesUntilNext * playbackRate
        const speedRatio = segmentLengthSamples / audioSamplesNeeded
        const closeToUnity = speedRatio >= 0.99 && speedRatio <= 1.01
        const needsLooping = !closeToUnity && audioSamplesNeeded > segmentLengthSamples
        const fadeSamplesInFile = VOICE_FADE_DURATION * data.sampleRate * playbackRate
        const voiceStartSamples = transientIndex === 0
            ? startSamples
            : Math.max(0, startSamples - fadeSamplesInFile)
        const newVoice = this.#createVoice(
            output, data, voiceStartSamples, endSamples,
            playbackRate, 0, sampleRate,
            transientPlayMode, needsLooping
        )
        if (isNotNull(newVoice)) {this.#voices.push(newVoice)}
        this.#accumulatedDrift = 0.0
    }

    #getSegmentInfo(transients: EventCollection<TransientMarkerBoxAdapter>,
                    index: int,
                    data: AudioData): Nullable<{startSamples: number, endSamples: number, hasNext: boolean, nextTransientFileSeconds: number}> {
        const current = transients.optAt(index)
        if (!isNotNull(current)) {return null}
        const next = transients.optAt(index + 1)
        return {
            startSamples: current.position * data.sampleRate,
            endSamples: isNotNull(next) ? next.position * data.sampleRate : data.numberOfFrames,
            hasNext: isNotNull(next),
            nextTransientFileSeconds: isNotNull(next) ? next.position : Number.POSITIVE_INFINITY
        }
    }

    #ppqnToSeconds(ppqn: number, warpMarkers: EventCollection<WarpMarkerBoxAdapter>): Nullable<number> {
        for (let i = 0; i < warpMarkers.length() - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (!isNotNull(left) || !isNotNull(right)) {continue}
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
            if (!isNotNull(left) || !isNotNull(right)) {continue}
            if (seconds >= left.seconds && seconds < right.seconds) {
                const alpha = (seconds - left.seconds) / (right.seconds - left.seconds)
                return left.position + alpha * (right.position - left.position)
            }
        }
        const last = warpMarkers.last()
        if (isNotNull(last) && seconds >= last.seconds) {return last.position}
        return 0.0
    }

    #createVoice(output: AudioBuffer,
                 data: AudioData,
                 startSamples: number,
                 endSamples: number,
                 playbackRate: number,
                 blockOffset: int,
                 sampleRate: number,
                 transientPlayMode: TransientPlayMode,
                 needsLooping: boolean,
                 initialReadPosition?: number): Nullable<Voice> {
        if (startSamples >= endSamples) {return null}
        if (transientPlayMode === TransientPlayMode.Once || !needsLooping) {
            return new OnceVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
        }
        if (transientPlayMode === TransientPlayMode.Repeat) {
            return new RepeatVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate, initialReadPosition)
        }
        if (isDefined(initialReadPosition)) {
            return new PingpongVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate, {
                position: initialReadPosition,
                direction: 1.0
            })
        }
        return new PingpongVoice(output, data, startSamples, endSamples, playbackRate, blockOffset, sampleRate)
    }
}
