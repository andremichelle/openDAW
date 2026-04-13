import {assert, Bits, int, isInstanceOf, Option, SortedSet, UUID} from "@moises-ai/lib-std"
import {AudioBuffer, AudioData, EventCollection, FadingEnvelope, LoopableRegion, RenderQuantum} from "@moises-ai/lib-dsp"
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
} from "@moises-ai/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {AudioGenerator, Block, BlockFlag, ProcessInfo, Processor} from "../../processing"
import {AbstractProcessor} from "../../AbstractProcessor"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {DeviceProcessor} from "../../DeviceProcessor"
import {NoteEventTarget} from "../../NoteEventSource"
import {VOICE_FADE_DURATION} from "./Tape/constants"
import {PitchVoice} from "./Tape/PitchVoice"
import {TimeStretchSequencer} from "./Tape/TimeStretchSequencer"

type Lane = {
    adapter: TrackBoxAdapter
    pitchVoices: SortedSet<UUID.Bytes, PitchVoice>
    fadingVoices: Array<PitchVoice>
    sequencer: TimeStretchSequencer
}

export class TapeDeviceProcessor extends AbstractProcessor implements DeviceProcessor, AudioGenerator {
    readonly #adapter: TapeDeviceBoxAdapter
    readonly #audioOutput: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #lanes: SortedSet<UUID.Bytes, Lane>
    readonly #fadingGainBuffer: Float32Array = new Float32Array(RenderQuantum)
    readonly #unitGainBuffer: Float32Array = (() => {
        const buffer = new Float32Array(RenderQuantum)
        buffer.fill(1.0)
        return buffer
    })()
    readonly #visitedUuids: Array<UUID.Bytes> = []

    #enabled: boolean = true

    constructor(context: EngineContext, adapter: TapeDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#audioOutput = new AudioBuffer(2)
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#lanes = UUID.newSet<Lane>(({adapter: {uuid}}) => uuid)
        this.ownAll(
            this.#adapter.box.enabled.catchupAndSubscribe(owner => {
                this.#enabled = owner.getValue()
                if (!this.#enabled) {this.reset()}
            }),
            this.#adapter.deviceHost().audioUnitBoxAdapter().tracks.catchupAndSubscribe({
                onAdd: (adapter: TrackBoxAdapter) => this.#lanes.add({
                    adapter,
                    pitchVoices: UUID.newSet<PitchVoice>(voice => voice.sourceUuid),
                    fadingVoices: [],
                    sequencer: new TimeStretchSequencer()
                }),
                onRemove: (adapter: TrackBoxAdapter) => this.#lanes.removeByKey(adapter.uuid),
                onReorder: (_adapter: TrackBoxAdapter) => {}
            }),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#audioOutput, this.outgoing)
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
            lane.pitchVoices.clear()
            lane.fadingVoices = []
            lane.sequencer.reset()
        })
    }

    process({blocks}: ProcessInfo): void {
        if (!this.#enabled) {return}
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
            this.#fadeOutAllPitchVoices(lane)
            lane.sequencer.reset()
            return
        }
        const {p0, p1, s0, s1, flags} = block
        if (!Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)) {return}
        if (Bits.some(flags, BlockFlag.discontinuous)) {
            this.#fadeOutAllPitchVoices(lane)
            lane.sequencer.reset()
        }
        this.#visitedUuids.length = 0
        const intervals = this.context.clipSequencing.iterate(adapter.uuid, p0, p1)
        for (const {optClip, sectionFrom, sectionTo} of intervals) {
            optClip.match({
                none: () => {
                    for (const region of adapter.regions.collection.iterateRange(p0, p1)) {
                        if (region.mute || !isInstanceOf(region, AudioRegionBoxAdapter)) {continue}
                        const file = region.file
                        const optData = file.getOrCreateLoader().data
                        if (optData.isEmpty()) {return}
                        const timeStretch = region.asPlayModeTimeStretch
                        if (timeStretch.nonEmpty()) {
                            const transients: EventCollection<TransientMarkerBoxAdapter> = file.transients
                            if (transients.length() < 2) {return}
                            for (const cycle of LoopableRegion.locateLoops(region, p0, p1)) {
                                const timeStretchBoxAdapter = timeStretch.unwrap()
                                this.#processPassTimestretch(lane, block, cycle,
                                    optData.unwrap(), timeStretchBoxAdapter, transients,
                                    region.waveformOffset.getValue(), region.fading,
                                    region.position, region.duration)
                            }
                        } else {
                            this.#visitedUuids.push(region.uuid)
                            for (const cycle of LoopableRegion.locateLoops(region, p0, p1)) {
                                this.#processPassPitch(
                                    lane, block, cycle, region, optData.unwrap(), region.uuid)
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
                                timeStretch, transients, clip.waveformOffset.getValue(), null, 0, clip.duration)
                        }
                    } else {
                        this.#visitedUuids.push(clip.uuid)
                        for (const cycle of LoopableRegion.locateLoops({
                            position: 0.0,
                            loopDuration: clip.duration,
                            loopOffset: 0.0,
                            complete: Number.POSITIVE_INFINITY
                        }, sectionFrom, sectionTo)) {
                            this.#processPassPitch(lane, block, cycle, clip, optData.unwrap(), clip.uuid)
                        }
                    }
                }
            })
        }
        lane.pitchVoices.removeByPredicate(voice => {
            if (this.#visitedUuids.some(uuid => UUID.equals(uuid, voice.sourceUuid))) {return false}
            voice.startFadeOut(0)
            lane.fadingVoices.push(voice)
            return true
        })
        const sn = s1 - s0
        for (const voice of lane.fadingVoices) {
            voice.process(s0, sn, this.#unitGainBuffer)
        }
        lane.fadingVoices = lane.fadingVoices.filter(voice => !voice.done())
    }

    #processPassPitch(lane: Lane,
                      block: Block,
                      cycle: LoopableRegion.LoopCycle,
                      adapter: AudioContentBoxAdapter,
                      data: AudioData,
                      sourceUuid: UUID.Bytes): void {
        const {p0, p1, s0, s1} = block
        const sn = s1 - s0
        const pn = p1 - p0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bp0 = s0 + sn * r0
        const bp1 = s0 + sn * r1
        const bpn = (bp1 - bp0) | 0
        const waveformOffset: number = adapter.waveformOffset.getValue()
        assert(s0 <= bp0 && bp1 <= s1, () => `Out of bounds ${bp0}, ${bp1}`)
        const asPlayModePitch = adapter.asPlayModePitchStretch
        if (adapter.isPlayModeNoStretch) {
            const elapsedSeconds = this.context.tempoMap.intervalToSeconds(cycle.rawStart, cycle.resultStart)
            const offset = (elapsedSeconds + waveformOffset) * data.sampleRate
            this.#updateOrCreatePitchVoice(lane, sourceUuid, data, data.sampleRate / sampleRate, offset, 0)
        } else if (asPlayModePitch.isEmpty()) {
            const audioDurationSamples = data.numberOfFrames
            const audioDurationNormalized = cycle.resultEndValue - cycle.resultStartValue
            const audioSamplesInCycle = audioDurationNormalized * audioDurationSamples
            const timelineSamplesInCycle = (cycle.resultEnd - cycle.resultStart) / pn * sn
            const playbackRate = audioSamplesInCycle / timelineSamplesInCycle
            const offset = cycle.resultStartValue * data.numberOfFrames + waveformOffset * data.sampleRate
            this.#updateOrCreatePitchVoice(lane, sourceUuid, data, playbackRate, offset, 0)
        } else {
            const pitchBoxAdapter = asPlayModePitch.unwrap()
            const warpMarkers = pitchBoxAdapter.warpMarkers
            const firstWarp = warpMarkers.first()
            const lastWarp = warpMarkers.last()
            if (firstWarp === null || lastWarp === null) {
                this.#evictPitchVoice(lane, sourceUuid)
                return
            }
            const contentPpqn = cycle.resultStart - cycle.rawStart
            if (contentPpqn < firstWarp.position || contentPpqn >= lastWarp.position) {
                this.#evictPitchVoice(lane, sourceUuid)
                return
            }
            const currentSeconds = this.#ppqnToSeconds(contentPpqn, cycle.resultStartValue, warpMarkers)
            const playbackRate = this.#getPlaybackRateFromWarp(contentPpqn, warpMarkers, data.sampleRate, pn, sn)
            const offset = (currentSeconds + waveformOffset) * data.sampleRate
            this.#updateOrCreatePitchVoice(lane, sourceUuid, data, playbackRate, offset, 0)
        }
        if (isInstanceOf(adapter, AudioRegionBoxAdapter) && adapter.fading.hasFading) {
            const regionPosition = adapter.position
            const regionDuration = adapter.duration
            const startPpqn = cycle.resultStart - regionPosition
            const endPpqn = cycle.resultEnd - regionPosition
            FadingEnvelope.fillGainBuffer(this.#fadingGainBuffer, startPpqn, endPpqn, regionDuration, bpn, adapter.fading)
        } else {
            this.#fadingGainBuffer.fill(1.0, 0, bpn)
        }
        const voice = lane.pitchVoices.getOrNull(sourceUuid)
        if (voice !== null) {
            voice.process(bp0 | 0, bpn, this.#fadingGainBuffer)
            if (voice.done()) {
                lane.pitchVoices.removeByKey(sourceUuid)
            }
        }
    }

    #updateOrCreatePitchVoice(lane: Lane, sourceUuid: UUID.Bytes, data: AudioData,
                              playbackRate: number, offset: number, blockOffset: int): void {
        const fadeLengthSamples = Math.round(VOICE_FADE_DURATION * sampleRate)
        const existing = lane.pitchVoices.getOrNull(sourceUuid)
        if (existing === null) {
            lane.pitchVoices.add(
                new PitchVoice(sourceUuid, this.#audioOutput, data, fadeLengthSamples, playbackRate, offset, blockOffset), true)
        } else if (existing.isFadingOut()) {
            lane.fadingVoices.push(existing)
            lane.pitchVoices.add(
                new PitchVoice(sourceUuid, this.#audioOutput, data, fadeLengthSamples, playbackRate, offset, blockOffset), true)
        } else {
            const drift = Math.abs(existing.readPosition - offset)
            if (drift > fadeLengthSamples) {
                existing.startFadeOut(blockOffset)
                lane.fadingVoices.push(existing)
                lane.pitchVoices.add(
                    new PitchVoice(sourceUuid, this.#audioOutput, data, fadeLengthSamples, playbackRate, offset, blockOffset), true)
            } else {
                existing.setPlaybackRate(playbackRate)
            }
        }
    }

    #evictPitchVoice(lane: Lane, sourceUuid: UUID.Bytes): void {
        const voice = lane.pitchVoices.removeByKeyIfExist(sourceUuid)
        if (voice !== null) {
            voice.startFadeOut(0)
            lane.fadingVoices.push(voice)
        }
    }

    #fadeOutAllPitchVoices(lane: Lane): void {
        for (const voice of lane.pitchVoices) {
            voice.startFadeOut(0)
            lane.fadingVoices.push(voice)
        }
        lane.pitchVoices.clear()
    }

    #processPassTimestretch(lane: Lane,
                            block: Block,
                            cycle: LoopableRegion.LoopCycle,
                            data: AudioData,
                            timeStretch: AudioTimeStretchBoxAdapter,
                            transients: EventCollection<TransientMarkerBoxAdapter>,
                            waveformOffset: number,
                            fadingConfig: FadingEnvelope.Config | null,
                            regionPosition: number,
                            regionDuration: number): void {
        this.#fadeOutAllPitchVoices(lane)
        const {p0, p1, s0, s1} = block
        const sn = s1 - s0
        const pn = p1 - p0
        const r0 = (cycle.resultStart - p0) / pn
        const r1 = (cycle.resultEnd - p0) / pn
        const bp0 = s0 + sn * r0
        const bp1 = s0 + sn * r1
        const bpn = (bp1 - bp0) | 0
        if (fadingConfig !== null && FadingEnvelope.hasFading(fadingConfig)) {
            const startPpqn = cycle.resultStart - regionPosition
            const endPpqn = cycle.resultEnd - regionPosition
            FadingEnvelope.fillGainBuffer(this.#fadingGainBuffer, startPpqn, endPpqn, regionDuration, bpn, fadingConfig)
        } else {
            this.#fadingGainBuffer.fill(1.0, 0, bpn)
        }
        lane.sequencer.process(
            this.#audioOutput,
            data,
            transients,
            timeStretch,
            waveformOffset,
            block,
            cycle,
            this.#fadingGainBuffer
        )
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
