import {DefaultObservableValue, Nullable, Terminable, Terminator} from "@opendaw/lib-std"
import type {PartialStemResult} from "@opendaw/lib-inference"

export const STREAM_LEAD_HOPS = 2
const MIN_PLAYABLE_SECONDS = 0.05

export type StemName = "drums" | "bass" | "other" | "vocals"
export const STEM_NAMES: ReadonlyArray<StemName> = ["drums", "bass", "other", "vocals"]

export interface StemGainControls {
    readonly mute: DefaultObservableValue<boolean>
    readonly solo: DefaultObservableValue<boolean>
}

interface Region {
    readonly startSample: number
    readonly length: number
    readonly buffers: Record<StemName, AudioBuffer>
}

export interface StemPreviewPlayer extends Terminable {
    readonly frontier: DefaultObservableValue<number>
    readonly playing: DefaultObservableValue<boolean>
    readonly stems: Record<StemName, StemGainControls>
    publish(partial: PartialStemResult): void
    play(): void
    stop(): void
    seek(sample: number): void
    currentSample(): number
}

export const createStemPreviewPlayer = (totalSamples: number, sampleRate: number, hop: number): StemPreviewPlayer => {
    const lifecycle = new Terminator()
    const audioContext = new AudioContext({sampleRate})
    const gains: Record<StemName, GainNode> = {
        drums: audioContext.createGain(), bass: audioContext.createGain(),
        other: audioContext.createGain(), vocals: audioContext.createGain()
    }
    for (const name of STEM_NAMES) {gains[name].connect(audioContext.destination)}

    const stems: Record<StemName, StemGainControls> = {
        drums:  {mute: new DefaultObservableValue(false), solo: new DefaultObservableValue(false)},
        bass:   {mute: new DefaultObservableValue(false), solo: new DefaultObservableValue(false)},
        other:  {mute: new DefaultObservableValue(false), solo: new DefaultObservableValue(false)},
        vocals: {mute: new DefaultObservableValue(false), solo: new DefaultObservableValue(false)}
    }
    const recomputeGains = (): void => {
        const anySolo = STEM_NAMES.some(name => stems[name].solo.getValue())
        for (const name of STEM_NAMES) {
            const audible = anySolo ? stems[name].solo.getValue() : !stems[name].mute.getValue()
            gains[name].gain.value = audible ? 1 : 0
        }
    }
    for (const name of STEM_NAMES) {
        lifecycle.ownAll(stems[name].mute.subscribe(recomputeGains), stems[name].solo.subscribe(recomputeGains))
    }
    recomputeGains()

    const frontier = new DefaultObservableValue(0)
    const playing = new DefaultObservableValue(false)
    const regions: Array<Region> = []
    let scheduledRegionCount = 0
    let activeSources: Array<AudioBufferSourceNode> = []
    let startedAt = 0          // audioContext.currentTime when (re)started
    let startOffsetSample = 0  // track sample position at that instant
    let autoStarted = false
    let resumeOnPublish = false
    let rafHandle: Nullable<number> = null

    const currentSample = (): number =>
        playing.getValue() ? startOffsetSample + (audioContext.currentTime - startedAt) * sampleRate : startOffsetSample

    const stopSources = (): void => {
        for (const source of activeSources) {source.onended = null; source.stop()}
        activeSources = []
        scheduledRegionCount = 0
    }

    const scheduleReadyRegions = (): void => {
        if (!playing.getValue()) {return}
        while (scheduledRegionCount < regions.length) {
            const region = regions[scheduledRegionCount++]
            const regionPositionSeconds = region.startSample / sampleRate
            const regionDurationSeconds = region.length / sampleRate
            const startOffsetSeconds = startOffsetSample / sampleRate
            let when = startedAt + (regionPositionSeconds - startOffsetSeconds)
            let offset = 0
            if (when < audioContext.currentTime) {
                offset = audioContext.currentTime - when
                if (offset >= regionDurationSeconds) {continue}
                when = audioContext.currentTime
            }
            for (const name of STEM_NAMES) {
                const source = audioContext.createBufferSource()
                source.buffer = region.buffers[name]
                source.connect(gains[name])
                source.start(when, offset)
                activeSources.push(source)
            }
        }
    }

    const stopUnderrunWatch = (): void => {
        if (rafHandle !== null) {cancelAnimationFrame(rafHandle); rafHandle = null}
    }
    const startUnderrunWatch = (): void => {
        const tick = (): void => {
            if (playing.getValue() && frontier.getValue() < totalSamples && currentSample() > frontier.getValue() + 1) {
                startOffsetSample = frontier.getValue()
                stopSources()
                playing.setValue(false)
                resumeOnPublish = true
            }
            if (playing.getValue()) {rafHandle = requestAnimationFrame(tick)}
        }
        rafHandle = requestAnimationFrame(tick)
    }

    const play = (): void => {
        if (playing.getValue()) {return}
        if (audioContext.state === "suspended") {audioContext.resume().catch(() => {})}
        if (frontier.getValue() < startOffsetSample + MIN_PLAYABLE_SECONDS * sampleRate) {
            resumeOnPublish = true
            return
        }
        startedAt = audioContext.currentTime
        scheduledRegionCount = 0
        playing.setValue(true)
        scheduleReadyRegions()
        startUnderrunWatch()
    }

    const stop = (): void => {
        if (!playing.getValue()) {return}
        startOffsetSample = currentSample()
        stopSources()
        playing.setValue(false)
        resumeOnPublish = false
        stopUnderrunWatch()
    }

    const seek = (sample: number): void => {
        const clamped = Math.max(0, Math.min(sample, frontier.getValue()))
        const wasPlaying = playing.getValue()
        stopSources()
        startOffsetSample = clamped
        startedAt = audioContext.currentTime
        if (wasPlaying) {scheduleReadyRegions()}
    }

    const publish = (partial: PartialStemResult): void => {
        const length = partial.toSample - partial.fromSample
        if (length <= 0) {return}
        const buffers: Partial<Record<StemName, AudioBuffer>> = {}
        for (const name of STEM_NAMES) {
            const buffer = audioContext.createBuffer(partial.channels, length, sampleRate)
            if (partial.channels === 1) {
                buffer.getChannelData(0).set(partial[name])
            } else {
                buffer.getChannelData(0).set(partial[name].subarray(0, length))
                buffer.getChannelData(1).set(partial[name].subarray(length, 2 * length))
            }
            buffers[name] = buffer
        }
        regions.push({startSample: partial.fromSample, length, buffers: buffers as Record<StemName, AudioBuffer>})
        frontier.setValue(partial.toSample)
        if (resumeOnPublish && !playing.getValue()) {
            resumeOnPublish = false
            play()
        } else if (playing.getValue()) {
            scheduleReadyRegions()
        }
        const leadSamples = Math.min(totalSamples, STREAM_LEAD_HOPS * hop)
        if (!autoStarted && !playing.getValue() && frontier.getValue() >= leadSamples) {
            autoStarted = true
            play()
        }
    }

    return {
        frontier, playing, stems, publish, play, stop, seek, currentSample,
        terminate(): void {
            stopUnderrunWatch()
            stopSources()
            lifecycle.terminate()
            audioContext.close().catch(() => {})
        }
    }
}
