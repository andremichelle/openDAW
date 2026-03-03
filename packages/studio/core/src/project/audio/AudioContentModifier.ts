import {EmptyExec, Exec, isDefined, isInstanceOf, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {seconds, TimeBase} from "@opendaw/lib-dsp"
import {
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    TransientMarkerBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {AudioContentBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioContentHelpers} from "./AudioContentHelpers"
import {Workers} from "../../Workers"
import {Pointers} from "@opendaw/studio-enums"

export namespace AudioContentModifier {
    export const toNotStretched = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => !adapter.isPlayModeNoStretch)
        if (audioAdapters.length === 0) {return EmptyExec}
        return () => audioAdapters.forEach((adapter) => {
            const audibleDuration = adapter.optWarpMarkers
                .mapOr(warpMarkers => warpMarkers.last()?.seconds ?? 0, 0)
            adapter.box.playMode.defer()
            adapter.asPlayModeTimeStretch.ifSome(({box}) => {
                if (box.pointerHub.filter(Pointers.AudioPlayMode).length === 0) {box.delete()}
            })
            adapter.asPlayModePitchStretch.ifSome(({box}) => {
                if (box.pointerHub.filter(Pointers.AudioPlayMode).length === 0) {box.delete()}
            })
            switchTimeBaseToSeconds(adapter, audibleDuration)
        })
    }

    export const toPitchStretch = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModePitchStretch.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        return () => audioAdapters.forEach((adapter) => {
            const optTimeStretch = adapter.asPlayModeTimeStretch
            const boxGraph = adapter.box.graph
            const pitchStretch = AudioPitchStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(pitchStretch)
            if (optTimeStretch.nonEmpty()) {
                const timeStretch = optTimeStretch.unwrap()
                const numPointers = timeStretch.box.pointerHub.filter(Pointers.AudioPlayMode).length
                if (numPointers === 0) {
                    timeStretch.warpMarkers.asArray()
                        .forEach(({box: {owner}}) => owner.refer(pitchStretch.warpMarkers))
                    timeStretch.box.delete()
                } else {
                    timeStretch.warpMarkers.asArray()
                        .forEach(({box: source}) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(source.position.getValue())
                            box.seconds.setValue(source.seconds.getValue())
                            box.owner.refer(pitchStretch.warpMarkers)
                        }))
                }
            } else {
                AudioContentHelpers.addDefaultWarpMarkers(boxGraph, pitchStretch,
                    adapter.duration, adapter.box.duration.getValue())
            }
            switchTimeBaseToMusical(adapter)
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
            const optPitchStretch = adapter.asPlayModePitchStretch
            const boxGraph = adapter.box.graph
            const timeStretch = AudioTimeStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(timeStretch)
            if (optPitchStretch.nonEmpty()) {
                const pitchStretch = optPitchStretch.unwrap()
                const numPointers = pitchStretch.box.pointerHub.filter(Pointers.AudioPlayMode).length
                if (numPointers === 0) {
                    pitchStretch.warpMarkers.asArray()
                        .forEach(({box: {owner}}) => owner.refer(timeStretch.warpMarkers))
                    pitchStretch.box.delete()
                } else {
                    pitchStretch.warpMarkers.asArray()
                        .forEach(({box: source}) => WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                            box.position.setValue(source.position.getValue())
                            box.seconds.setValue(source.seconds.getValue())
                            box.owner.refer(timeStretch.warpMarkers)
                        }))
                }
            } else {
                AudioContentHelpers.addDefaultWarpMarkers(boxGraph, timeStretch,
                    adapter.duration, adapter.box.duration.getValue())
            }
            if (isDefined(transients) && adapter.file.transients.length() === 0) {
                const markersField = adapter.file.box.transientMarkers
                transients.forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.owner.refer(markersField)
                    box.position.setValue(position)
                }))
            }
            switchTimeBaseToMusical(adapter)
        })
    }

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

    const switchTimeBaseToMusical = (adapter: AudioContentBoxAdapter): void => {
        const {timeBase} = adapter
        if (timeBase === TimeBase.Musical) {return}
        const {box} = adapter
        box.duration.setValue(adapter.duration)
        if (isInstanceOf(adapter, AudioRegionBoxAdapter)) {
            const {box: {loopDuration, loopOffset}} = adapter
            loopOffset.setValue(adapter.loopOffset)
            loopDuration.setValue(adapter.loopDuration)
        }
        box.timeBase.setValue(TimeBase.Musical)
    }
}