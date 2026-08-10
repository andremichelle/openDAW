import {
    EmptyExec,
    Exec,
    isDefined,
    isInstanceOf,
    isNotNull,
    Option,
    quantizeRound,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
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

export namespace AudioContentModifier {
    // A region within a millisecond of its audio still covers it exactly; anything beyond was set by hand.
    const COVERS_AUDIO_TOLERANCE: seconds = 0.001

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
        return () => audioAdapters.forEach((adapter) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const pitchStretch = AudioPitchStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(pitchStretch)
            switchTimeBaseToMusical(adapter, adoptWarpMarkers(optPrev, pitchStretch, boxGraph, adapter))
        })
    }

    export const toSignalsmith = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModeSignalsmith.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        return () => audioAdapters.forEach((adapter) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const signalsmith = AudioSignalsmithBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(signalsmith)
            switchTimeBaseToMusical(adapter, adoptWarpMarkers(optPrev, signalsmith, boxGraph, adapter))
        })
    }

    export const toTimeStretch = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModeTimeStretch.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        const handler = RuntimeNotifier.progress({headline: "Detecting Transients..."})
        const tasks = await Promise.all(audioAdapters.map(async adapter => {
            if (adapter.file.transients.length() === 0) {
                return {
                    adapter,
                    transients: await Workers.Transients.detect(await adapter.file.audioData)
                }
            }
            return {adapter}
        }))
        handler.terminate()
        return () => tasks.forEach(({adapter, transients}) => {
            const optPrev: Option<AudioPlayMode> = adapter.observableOptPlayMode.map(mode => mode)
            const boxGraph = adapter.box.graph
            const timeStretch = AudioTimeStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(timeStretch)
            const optMeasured = adoptWarpMarkers(optPrev, timeStretch, boxGraph, adapter)
            if (isDefined(transients) && adapter.file.transients.length() === 0) {
                const markersField = adapter.file.box.transientMarkers
                transients.forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.owner.refer(markersField)
                    box.position.setValue(position)
                }))
            }
            switchTimeBaseToMusical(adapter, optMeasured)
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

    // Two lengths that a not-stretched region is free to disagree about, and confusing them is what left the
    // content unwarped: `audibleSeconds` is how much AUDIO there is, `contentSeconds` is how long the region
    // has been made. Enlarge a region past its audio and the old code seeded the last marker from the region,
    // so it pointed into silence past the audio end and the mapping stayed 1:1 real time.
    const audibleSeconds = (adapter: AudioContentBoxAdapter): seconds => adapter.optFile
        .mapOr(file => Math.max(0.0, file.endInSeconds - file.startInSeconds - adapter.waveformOffset.getValue()), 0.0)

    const contentSeconds = (adapter: AudioContentBoxAdapter): seconds => isInstanceOf(adapter, AudioRegionBoxAdapter)
        ? adapter.box.loopDuration.getValue()
        : adapter.box.duration.getValue()

    const contentPulses = (adapter: AudioContentBoxAdapter): ppqn => isInstanceOf(adapter, AudioRegionBoxAdapter)
        ? adapter.loopDuration
        : adapter.duration

    // The sample's own musical length, quantised exactly as `AudioContentFactory` does at creation time.
    const musicalPulses = (seconds: seconds, bpm: number): ppqn => {
        const pulses = PPQN.secondsToPulses(seconds, bpm)
        return pulses >= PPQN.SemiQuaver ? quantizeRound(pulses, PPQN.SemiQuaver) : pulses
    }

    // Read from the loader already holding this sample rather than from storage, so the conversion stays one
    // synchronous transaction with no window in which the region can be deleted underneath it.
    const sampleBpm = (adapter: AudioContentBoxAdapter): number =>
        adapter.optFile.mapOr(file => file.getOrCreateLoader().meta.mapOr(({bpm}) => bpm, 0.0), 0.0)

    // Growing a region must never push it into its neighbour: that is how the "regions overlap" family starts.
    // The span is clamped to the gap instead of clipping whatever sits there, which the user never asked for.
    const availablePulses = (adapter: AudioContentBoxAdapter): ppqn => {
        if (!isInstanceOf(adapter, AudioRegionBoxAdapter)) {return Number.POSITIVE_INFINITY}
        return adapter.trackBoxAdapter.mapOr(track => {
            const next = track.regions.collection.greaterEqual(adapter.position + 1)
            return isNotNull(next) ? next.position - adapter.position : Number.POSITIVE_INFINITY
        }, Number.POSITIVE_INFINITY)
    }

    // Move the warp markers of the previous play-mode (if any) onto the new play-mode box, so switching between
    // Pitch / Grain / Signalsmith preserves the user's warp edits; delete the old box if nothing else points at
    // it (else clone the markers). With no previous stretch (was NoWarp), seed default markers instead.
    //
    // The seeded pair is always (musical span, AUDIO length). Which musical span depends on what the region
    // says: one still exactly covering its audio states no intent, so the sample's own tempo decides and the
    // region is resized to match. Once the span differs the user has stated the musical length in the
    // timeline, and the audio is mapped onto that span instead. Returns the span to resize to, if any.
    const adoptWarpMarkers = (optPrev: Option<AudioPlayMode>,
                              newBox: AudioPitchStretchBox | AudioTimeStretchBox | AudioSignalsmithBox,
                              boxGraph: BoxGraph,
                              adapter: AudioContentBoxAdapter): Option<ppqn> => optPrev.match({
        none: () => {
            const audible = audibleSeconds(adapter)
            const seconds = audible > 0.0 ? audible : contentSeconds(adapter)
            const bpm = sampleBpm(adapter)
            // A known tempo defines the mapping outright: it is the one statement about how many bars this
            // audio IS, and it holds however the region has been sized since. Only when the sample has no
            // tempo does the region's own span have to stand in.
            const measured = bpm > 0.0 ? musicalPulses(seconds, bpm) : 0
            const pulses = measured > 0 ? measured : contentPulses(adapter)
            AudioContentHelpers.addDefaultWarpMarkers(boxGraph, newBox, pulses, seconds)
            // Resizing is the separate question. A region still covering its audio has no length worth
            // preserving, so it takes the measured span. One the user has trimmed or extended keeps theirs.
            const covers = Math.abs(contentSeconds(adapter) - seconds) < COVERS_AUDIO_TOLERANCE
            return measured > 0 && covers ? Option.wrap(measured) : Option.None
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

    const switchTimeBaseToMusical = (adapter: AudioContentBoxAdapter, optMeasured: Option<ppqn>): void => {
        const {timeBase} = adapter
        if (timeBase === TimeBase.Musical) {return}
        const {box} = adapter
        optMeasured.match({
            // The span the user set is already what the region reads at the project tempo, so carrying the
            // converted values over keeps it exactly where it was.
            none: () => {
                box.duration.setValue(adapter.duration)
                if (isInstanceOf(adapter, AudioRegionBoxAdapter)) {
                    const {box: {loopDuration, loopOffset}} = adapter
                    loopOffset.setValue(adapter.loopOffset)
                    loopDuration.setValue(adapter.loopDuration)
                }
            },
            some: measured => {
                if (!isInstanceOf(adapter, AudioRegionBoxAdapter)) {
                    box.duration.setValue(measured)
                    return
                }
                const {box: {duration, loopDuration, loopOffset}} = adapter
                const loopSeconds = loopDuration.getValue()
                const durationSeconds = duration.getValue()
                // Scale by the same factor so a region looping its content twice still loops it twice.
                const scale = loopSeconds > 0.0 ? measured / loopSeconds : 0.0
                const scaled = durationSeconds === loopSeconds ? measured : durationSeconds * scale
                const available = availablePulses(adapter)
                loopOffset.setValue(loopOffset.getValue() * scale)
                loopDuration.setValue(measured)
                duration.setValue(available > 0.0 ? Math.min(scaled, available) : scaled)
            }
        })
        box.timeBase.setValue(TimeBase.Musical)
    }
}