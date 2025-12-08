import {asDefined, assert, Bits, int, isInstanceOf, Nullable, Option, SortedSet, UUID} from "@opendaw/lib-std"
import {AudioBuffer, AudioData, EventCollection, LoopableRegion, RenderQuantum} from "@opendaw/lib-dsp"
import {
    AudioClipBoxAdapter,
    AudioContentBoxAdapter,
    AudioRegionBoxAdapter,
    AudioTimeStretchBoxAdapter,
    TapeDeviceBoxAdapter,
    TrackBoxAdapter,
    TrackType,
    TransientMarkerBoxAdapter,
    WarpMarkerBoxAdapter
} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {EngineContext} from "../../EngineContext"
import {AudioGenerator, Block, BlockFlag, ProcessInfo, Processor} from "../../processing"
import {AbstractProcessor} from "../../AbstractProcessor"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {DeviceProcessor} from "../../DeviceProcessor"
import {NoteEventTarget} from "../../NoteEventSource"
import {VOICE_FADE_DURATION} from "./Tape/constants"
import {PitchVoice} from "./Tape/PitchVoice"
import {Voice} from "./Tape/Voice"
import {TimeStretchSequencer} from "./Tape/TimeStretchSequencer"

// Union type for all voice types used in lanes
// TODO: Simplify once PitchStretchSequencer is implemented
type AnyVoice = Voice | PitchVoice

type Lane = {
    adapter: TrackBoxAdapter
    voices: Array<AnyVoice>
    sequencer: TimeStretchSequencer
}

export class TapeDeviceProcessor extends AbstractProcessor implements DeviceProcessor, AudioGenerator {
    readonly #adapter: TapeDeviceBoxAdapter
    readonly #audioOutput: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #lanes: SortedSet<UUID.Bytes, Lane>

    constructor(context: EngineContext, adapter: TapeDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#audioOutput = new AudioBuffer(2)
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#lanes = UUID.newSet<Lane>(({adapter: {uuid}}) => uuid)
        this.ownAll(
            this.#adapter.deviceHost().audioUnitBoxAdapter().tracks.catchupAndSubscribe({
                onAdd: (adapter: TrackBoxAdapter) => this.#lanes.add({adapter, voices: [], sequencer: new TimeStretchSequencer()}),
                onRemove: (adapter: TrackBoxAdapter) => this.#lanes.removeByKey(adapter.uuid),
                onReorder: (_adapter: TrackBoxAdapter) => {}
            }),
            context.registerProcessor(this)
        )
    }

    // false negative Webstorm
    // noinspection JSUnusedGlobalSymbols
    get noteEventTarget(): Option<NoteEventTarget & DeviceProcessor> {return Option.None}
    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}
    get audioOutput(): AudioBuffer {return this.#audioOutput}

    reset(): void {
        this.#peaks.clear()
        this.#audioOutput.clear()
        this.eventInput.clear()
        this.#lanes.forEach(lane => {
            lane.voices = []
            lane.sequencer.reset()
        })
    }

    process({blocks}: ProcessInfo): void {
        this.#audioOutput.clear(0, RenderQuantum)
        this.#lanes.forEach(lane => blocks.forEach(block => this.#processBlock(lane, block)))
        this.#audioOutput.assertSanity()
        const [outL, outR] = this.#audioOutput.channels()
        this.#peaks.process(outL, outR)
    }

    parameterChanged(_parameter: AutomatableParameter): void {}

    #processBlock(lane: Lane, block: Block): void {
        const {adapter} = lane
        if (adapter.type !== TrackType.Audio || !adapter.enabled.getValue()) {
            lane.voices.forEach(voice => voice.startFadeOut(0))
            lane.sequencer.reset()
            return
        }
        const {p0, p1, flags} = block
        if (!Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)) {return}
        const intervals = this.context.clipSequencing.iterate(adapter.uuid, p0, p1)
        for (const {optClip, sectionFrom, sectionTo} of intervals) {
            optClip.match({
                none: () => {
                    for (const region of adapter.regions.collection.iterateRange(p0, p1)) {
                        if (region.mute || !isInstanceOf(region, AudioRegionBoxAdapter)) {continue}
                        const file = region.file
                        const optData = file.getOrCreateLoader().data
                        if (optData.isEmpty()) {return}
                        const waveformOffset = region.waveformOffset.getValue()
                        const timeStretch = region.asPlayModeTimeStretch
                        if (timeStretch.nonEmpty()) {
                            const transients: EventCollection<TransientMarkerBoxAdapter> = file.transients
                            if (transients.length() < 2) {return}
                            for (const cycle of LoopableRegion.locateLoops(region, p0, p1)) {
                                const timeStretchBoxAdapter = timeStretch.unwrap()
                                this.#processPassTimestretch(lane, block, cycle,
                                    optData.unwrap(), timeStretchBoxAdapter, transients, waveformOffset)
                            }
                        } else {
                            for (const cycle of LoopableRegion.locateLoops(region, p0, p1)) {
                                this.#processPassPitch(
                                    lane, block, cycle, region, optData.unwrap())
                            }
                        }
                    }
                },
                some: clip => {
                    if (!isInstanceOf(clip, AudioClipBoxAdapter)) {return}
                    const file = clip.file
                    const optData = file.getOrCreateLoader().data
                    if (optData.isEmpty()) {return}
                    const asPlayModeTimeStretch = clip.asPlayModeTimeStretch
                    if (asPlayModeTimeStretch.nonEmpty()) {
                        const timeStretch = asPlayModeTimeStretch.unwrap()
                        const transients: EventCollection<TransientMarkerBoxAdapter> = file.transients
                        if (transients.length() < 2) {return}
                        for (const cycle of LoopableRegion.locateLoops({
                            position: 0.0,
                            loopDuration: clip.duration,
                            loopOffset: 0.0,
                            complete: Number.POSITIVE_INFINITY
                        }, sectionFrom, sectionTo)) {
                            this.#processPassTimestretch(lane, block, cycle, optData.unwrap(),
                                timeStretch, transients, clip.waveformOffset.getValue())
                        }
                    } else {
                        for (const cycle of LoopableRegion.locateLoops({
                            position: 0.0,
                            loopDuration: clip.duration,
                            loopOffset: 0.0,
                            complete: Number.POSITIVE_INFINITY
                        }, sectionFrom, sectionTo)) {
                            this.#processPassPitch(lane, block, cycle, clip, optData.unwrap())
                        }
                    }
                }
            })
        }
    }

    #processPassPitch(lane: Lane,
                      block: Block,
                      cycle: LoopableRegion.LoopCycle,
                      adapter: AudioContentBoxAdapter,
                      data: AudioData): void {
        const {p0, p1, s0, s1, flags} = block
        const sn = s1 - s0
        const pn = p1 - p0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bp0 = s0 + sn * r0
        const bp1 = s0 + sn * r1
        const bpn = (bp1 - bp0) | 0
        const waveformOffset: number = adapter.waveformOffset.getValue()
        assert(s0 <= bp0 && bp1 <= s1, () => `Out of bounds ${bp0}, ${bp1}`)
        if (Bits.some(flags, BlockFlag.discontinuous)) {
            lane.voices.forEach(voice => voice.startFadeOut(0))
            lane.sequencer.reset()
        }
        const asPlayModePitch = adapter.asPlayModePitchStretch
        if (asPlayModePitch.isEmpty() || adapter.observableOptPlayMode.isEmpty()) {
            const audioDurationSamples = data.numberOfFrames
            const audioDurationNormalized = cycle.resultEndValue - cycle.resultStartValue
            const audioSamplesInCycle = audioDurationNormalized * audioDurationSamples
            const timelineSamplesInCycle = (cycle.resultEnd - cycle.resultStart) / pn * sn
            const playbackRate = audioSamplesInCycle / timelineSamplesInCycle
            const offset = cycle.resultStartValue * data.numberOfFrames + waveformOffset * data.sampleRate
            this.#updateOrCreatePitchVoice(lane, data, playbackRate, offset, 0)
        } else {
            const pitchBoxAdapter = asPlayModePitch.unwrap()
            const warpMarkers = pitchBoxAdapter.warpMarkers
            const firstWarp = warpMarkers.first()
            const lastWarp = warpMarkers.last()
            if (firstWarp === null || lastWarp === null) {
                lane.voices.forEach(voice => voice.startFadeOut(0))
                return
            }
            const contentPpqn = cycle.resultStart - cycle.rawStart
            if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) {
                lane.voices.forEach(voice => voice.startFadeOut(0))
                return
            }
            const currentSeconds = this.#ppqnToSeconds(contentPpqn, cycle.resultStartValue, warpMarkers)
            const playbackRate = this.#getPlaybackRateFromWarp(contentPpqn, warpMarkers, data.sampleRate, pn, sn)
            const offset = (currentSeconds + waveformOffset) * data.sampleRate
            this.#updateOrCreatePitchVoice(lane, data, playbackRate, offset, 0)
        }
        for (const voice of lane.voices) {
            voice.process(bp0 | 0, bpn)
        }
        lane.voices = lane.voices.filter(voice => !voice.done())
    }

    #updateOrCreatePitchVoice(lane: Lane, data: AudioData, playbackRate: number, offset: number, blockOffset: int): void {
        const fadeLengthSamples = Math.round(VOICE_FADE_DURATION * data.sampleRate)
        if (lane.voices.length === 0) {
            lane.voices.push(new PitchVoice(this.#audioOutput, data, fadeLengthSamples, playbackRate, offset, blockOffset))
        } else {
            let hasActiveVoice = false
            for (const voice of lane.voices) {
                if (voice instanceof PitchVoice) {
                    if (voice.isFadingOut()) {
                        continue
                    }
                    const drift = Math.abs(voice.readPosition - offset)
                    if (drift > fadeLengthSamples) {
                        voice.startFadeOut(blockOffset)
                    } else {
                        voice.setPlaybackRate(playbackRate)
                        hasActiveVoice = true
                    }
                } else {
                    // Fade out non-PitchVoice voices (OnceVoice, RepeatVoice, PingpongVoice)
                    voice.startFadeOut(blockOffset)
                }
            }
            if (!hasActiveVoice) {
                lane.voices.push(new PitchVoice(this.#audioOutput, data, fadeLengthSamples, playbackRate, offset, blockOffset))
            }
        }
    }

    #processPassTimestretch(lane: Lane,
                            block: Block,
                            cycle: LoopableRegion.LoopCycle,
                            data: AudioData,
                            timeStretch: AudioTimeStretchBoxAdapter,
                            transients: EventCollection<TransientMarkerBoxAdapter>,
                            waveformOffset: number): void {
        const {p0, p1, s0, s1, flags} = block
        const isDiscontinuous = Bits.some(flags, BlockFlag.discontinuous)

        if (isDiscontinuous) {
            lane.sequencer.reset()
            lane.voices.forEach(voice => voice.startFadeOut(0))
        }

        // Fade out any PitchVoice when in timestretch mode
        for (const voice of lane.voices) {
            if (voice instanceof PitchVoice) {
                voice.startFadeOut(0)
            }
        }

        const sn = s1 - s0
        const pn = p1 - p0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bp0 = s0 + sn * r0
        const bp1 = s0 + sn * r1
        const bpn = (bp1 - bp0) | 0
        const {warpMarkers, transientPlayMode, playbackRate} = timeStretch

        assert(s0 <= bp0 && bp1 <= s1, () => `Out of bounds ${bp0}, ${bp1}`)

        const firstWarp = asDefined(warpMarkers.first(), "missing first warp marker")
        const lastWarp = asDefined(warpMarkers.last(), "missing last warp marker")
        const contentPpqn = cycle.resultStart - cycle.rawStart

        if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) {return}

        const warpSeconds = this.#ppqnToSeconds(contentPpqn, cycle.resultStartValue, warpMarkers)
        const fileSeconds = warpSeconds + waveformOffset

        // Clamp to valid file range
        if (fileSeconds < 0.0 || fileSeconds >= data.numberOfFrames / data.sampleRate) {return}

        // Calculate file position at block END for transient detection
        const contentPpqnEnd = contentPpqn + pn
        const warpSecondsEnd = this.#ppqnToSeconds(contentPpqnEnd, cycle.resultEndValue, warpMarkers)
        const fileSecondsEnd = warpSecondsEnd + waveformOffset

        // Transfer voices to sequencer (filter out PitchVoice)
        lane.sequencer.voices = lane.voices.filter((v): v is Voice => !(v instanceof PitchVoice))

        // Process via sequencer
        lane.sequencer.process(
            this.#audioOutput,
            data,
            transients,
            warpMarkers,
            transientPlayMode,
            playbackRate,
            waveformOffset,
            this.context.tempoMap,
            fileSecondsEnd,
            contentPpqn,
            pn,
            bp0 | 0,
            bpn
        )

        // Transfer voices back from sequencer (keep PitchVoice instances)
        const pitchVoices = lane.voices.filter(v => v instanceof PitchVoice)
        lane.voices = [...pitchVoices, ...lane.sequencer.voices]

        // Clean up done voices
        lane.voices = lane.voices.filter(voice => !voice.done())
    }

    #getPlaybackRateFromWarp(ppqn: number,
                             warpMarkers: EventCollection<WarpMarkerBoxAdapter>,
                             sampleRate: number, pn: number, sn: number): number {
        const leftIndex = warpMarkers.floorLastIndex(ppqn)
        const left = warpMarkers.optAt(leftIndex)
        const right = warpMarkers.optAt(leftIndex + 1)
        if (left === null || right === null) {
            return 1.0
        }
        const ppqnDelta = right.position - left.position
        const secondsDelta = right.seconds - left.seconds
        const samplesDelta = secondsDelta * sampleRate
        const audioSamplesPerPpqn = samplesDelta / ppqnDelta
        const timelineSamplesPerPpqn = sn / pn
        return audioSamplesPerPpqn / timelineSamplesPerPpqn
    }

    #ppqnToSeconds(ppqn: number, normalizedFallback: number, warpMarkers: EventCollection<WarpMarkerBoxAdapter>): number {
        const leftIndex = warpMarkers.floorLastIndex(ppqn)
        const left = warpMarkers.optAt(leftIndex)
        const right = warpMarkers.optAt(leftIndex + 1)
        if (left === null || right === null) {return normalizedFallback}
        const alpha = (ppqn - left.position) / (right.position - left.position)
        return left.seconds + alpha * (right.seconds - left.seconds)
    }
}