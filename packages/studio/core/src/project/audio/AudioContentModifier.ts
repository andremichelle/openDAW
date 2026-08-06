import {EmptyExec, Exec, isDefined, isInstanceOf, isNotNull, Option, quantizeRound, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {EventCollection, ppqn, PPQN, seconds, TimeBase} from "@opendaw/lib-dsp"
import {
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioSignalsmithBox,
    AudioTimeStretchBox,
    TransientMarkerBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {AudioContentBoxAdapter, AudioPlayMode, AudioRegionBoxAdapter, WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {AudioContentHelpers} from "./AudioContentHelpers"
import {Workers} from "../../Workers"
import {Pointers} from "@opendaw/studio-enums"
import {SampleStorage} from "../../samples/SampleStorage"

export namespace AudioContentModifier {
    export const toNotStretched = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => !adapter.isPlayModeNoStretch)
        if (audioAdapters.length === 0) {return EmptyExec}
        return () => audioAdapters.forEach((adapter) => {
            const audibleDuration = adapter.optWarpMarkers
                .mapOr(warpMarkers => warpMarkers.last()?.seconds ?? 0, 0)
            const loopOffsetSeconds = isInstanceOf(adapter, AudioRegionBoxAdapter)
                ? adapter.optWarpMarkers.mapOr(warpMarkers => warpPositionToSeconds(warpMarkers, adapter.loopOffset), 0)
                : 0
            if (loopOffsetSeconds !== 0) {
                adapter.box.waveformOffset.setValue(adapter.waveformOffset.getValue() + loopOffsetSeconds)
            }
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            adapter.box.playMode.defer()
            optPrev.ifSome(({box}) => {
                if (box.pointerHub.filter(Pointers.AudioPlayMode).length === 0) {box.delete()}
            })
            switchTimeBaseToSeconds(adapter, audibleDuration)
        })
    }

    export const toPitchStretch = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModePitchStretch.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        const tasks = await Promise.all(audioAdapters.map(async adapter => ({adapter, bpm: await readSampleBpm(adapter)})))
        return () => tasks.forEach(({adapter, bpm}) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const pitchStretch = AudioPitchStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(pitchStretch)
            switchTimeBaseToMusical(adapter, adoptWarpMarkers(optPrev, pitchStretch, boxGraph, adapter, bpm))
        })
    }

    export const toSignalsmith = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModeSignalsmith.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        const tasks = await Promise.all(audioAdapters.map(async adapter => ({adapter, bpm: await readSampleBpm(adapter)})))
        return () => tasks.forEach(({adapter, bpm}) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const signalsmith = AudioSignalsmithBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(signalsmith)
            switchTimeBaseToMusical(adapter, adoptWarpMarkers(optPrev, signalsmith, boxGraph, adapter, bpm))
        })
    }

    export const toTimeStretch = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModeTimeStretch.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        const handler = RuntimeNotifier.progress({headline: "Detecting Transients..."})
        const tasks = await Promise.all(audioAdapters.map(async adapter => {
            const bpm = await readSampleBpm(adapter)
            if (adapter.file.transients.length() === 0) {
                return {
                    adapter,
                    bpm,
                    transients: await Workers.Transients.detect(await adapter.file.audioData)
                }
            }
            return {adapter, bpm}
        }))
        handler.terminate()
        return () => tasks.forEach(({adapter, bpm, transients}) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const timeStretch = AudioTimeStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(timeStretch)
            const optWarped = adoptWarpMarkers(optPrev, timeStretch, boxGraph, adapter, bpm)
            if (isDefined(transients) && adapter.file.transients.length() === 0) {
                const markersField = adapter.file.box.transientMarkers
                transients.forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.owner.refer(markersField)
                    box.position.setValue(position)
                }))
            }
            switchTimeBaseToMusical(adapter, optWarped)
        })
    }

    const warpPositionToSeconds = (warpMarkers: EventCollection<WarpMarkerBoxAdapter>, position: ppqn): seconds => {
        const length = warpMarkers.length()
        if (length === 0) {return 0}
        const first = warpMarkers.first()
        const last = warpMarkers.last()
        if (!isNotNull(first) || !isNotNull(last)) {return 0}
        if (position <= first.position) {return first.seconds}
        if (position >= last.position) {return last.seconds}
        for (let i = 0; i < length - 1; i++) {
            const left = warpMarkers.optAt(i)
            const right = warpMarkers.optAt(i + 1)
            if (isNotNull(left) && isNotNull(right) && position >= left.position && position < right.position) {
                const alpha = (position - left.position) / (right.position - left.position)
                return left.seconds + alpha * (right.seconds - left.seconds)
            }
        }
        return last.seconds
    }

    const sampleExtent = (adapter: AudioContentBoxAdapter): {ppqn: number, seconds: number} => {
        if (isInstanceOf(adapter, AudioRegionBoxAdapter)) {
            return {ppqn: adapter.loopDuration, seconds: adapter.box.loopDuration.getValue()}
        }
        return {ppqn: adapter.duration, seconds: adapter.box.duration.getValue()}
    }

    const warpedExtent = (adapter: AudioContentBoxAdapter, bpm: number): {ppqn: number, seconds: number} => {
        const {seconds} = sampleExtent(adapter)
        const pulses = PPQN.secondsToPulses(seconds, bpm)
        return {ppqn: pulses >= PPQN.SemiQuaver ? quantizeRound(pulses, PPQN.SemiQuaver) : pulses, seconds}
    }

    const readSampleBpm = async (adapter: AudioContentBoxAdapter): Promise<number> =>
        (await Option.async(SampleStorage.get().loadMeta(adapter.file.uuid))).mapOr(meta => meta.bpm, 0)

    // Move the warp markers of the previous play-mode (if any) onto the new play-mode box, so switching between
    // Pitch / Grain / Signalsmith preserves the user's warp edits; delete the old box if nothing else points at
    // it (else clone the markers). With no previous stretch (was NoWarp), seed default markers warped to the
    // sample's own bpm as stored in its metadata; the project-tempo-relative extent is only a defensive
    // fallback for callers that never wrote a meaningful bpm. Returns the bpm-warped marker extent when one
    // was seeded, so the timebase switch can size the region from it instead of the project-tempo conversion.
    const adoptWarpMarkers = (optPrev: Option<AudioPlayMode>,
                              newBox: AudioPitchStretchBox | AudioTimeStretchBox | AudioSignalsmithBox,
                              boxGraph: BoxGraph,
                              adapter: AudioContentBoxAdapter,
                              bpm: number): Option<ppqn> => optPrev.match({
        none: () => {
            const {ppqn, seconds} = bpm > 0 ? warpedExtent(adapter, bpm) : sampleExtent(adapter)
            AudioContentHelpers.addDefaultWarpMarkers(boxGraph, newBox, ppqn, seconds)
            return bpm > 0 ? Option.wrap(ppqn) : Option.None
        },
        some: from => {
            const to = newBox.warpMarkers
            const shared = from.box.pointerHub.filter(Pointers.AudioPlayMode).length > 0
            if (shared) {
                from.warpMarkers.asArray().forEach(({box: source}) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(source.position.getValue())
                    box.seconds.setValue(source.seconds.getValue())
                    box.owner.refer(to)
                }))
            } else {
                from.warpMarkers.asArray().forEach(({box: {owner}}) => owner.refer(to))
                from.box.delete()
            }
            return Option.None
        }
    })

    const switchTimeBaseToSeconds = ({box, timeBase}: AudioContentBoxAdapter, audibleDuration: seconds): void => {
        if (timeBase === TimeBase.Seconds) {return}
        box.timeBase.setValue(TimeBase.Seconds)
        box.duration.setValue(audibleDuration)
        box.accept({
            visitAudioRegionBox: (box: AudioRegionBox) => {
                box.loopOffset.setValue(0)
                box.loopDuration.setValue(audibleDuration)
            }
        })
    }

    const switchTimeBaseToMusical = (adapter: AudioContentBoxAdapter, optWarpedDuration: Option<ppqn>): void => {
        const {timeBase} = adapter
        if (timeBase === TimeBase.Musical) {return}
        const {box} = adapter
        optWarpedDuration.match({
            none: () => {
                box.duration.setValue(adapter.duration)
                if (isInstanceOf(adapter, AudioRegionBoxAdapter)) {
                    const {box: {loopDuration, loopOffset}} = adapter
                    loopOffset.setValue(adapter.loopOffset)
                    loopDuration.setValue(adapter.loopDuration)
                }
            },
            some: warpedPpqn => {
                if (isInstanceOf(adapter, AudioRegionBoxAdapter)) {
                    const {box: {loopDuration, loopOffset}} = adapter
                    const loopSeconds = loopDuration.getValue()
                    const scale = loopSeconds > 0 ? warpedPpqn / loopSeconds : 0
                    box.duration.setValue(box.duration.getValue() * scale)
                    loopOffset.setValue(loopOffset.getValue() * scale)
                    loopDuration.setValue(warpedPpqn)
                } else {
                    box.duration.setValue(warpedPpqn)
                }
            }
        })
        box.timeBase.setValue(TimeBase.Musical)
    }
}