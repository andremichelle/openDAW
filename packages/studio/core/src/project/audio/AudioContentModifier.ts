import {EmptyExec, Exec, isDefined, isInstanceOf, UUID} from "@opendaw/lib-std"
import {TimeBase} from "@opendaw/lib-dsp"
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

export namespace AudioContentModifier {
    export const toNotStretched = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => !adapter.isPlayModeNoStretch)
        if (audioAdapters.length === 0) {return EmptyExec}
        return () => audioAdapters.forEach((adapter) => {
            adapter.box.playMode.defer()
            switchTimeBaseToSeconds(adapter)
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
                if (timeStretch.box.pointerHub.isEmpty()) {
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
                AudioContentHelpers.addDefaultWarpMarkers(boxGraph, pitchStretch, adapter.duration, adapter.file.endInSeconds)
            }
            switchTimeBaseToMusical(adapter)
        })
    }

    export const toTimeStretch = async (adapters: ReadonlyArray<AudioContentBoxAdapter>): Promise<Exec> => {
        const audioAdapters = adapters.filter(adapter => adapter.asPlayModeTimeStretch.isEmpty())
        if (audioAdapters.length === 0) {return EmptyExec}
        const tasks = await Promise.all(audioAdapters.map(async adapter => {
            if (adapter.file.transients.length() === 0) {
                return {
                    adapter,
                    transients: await Workers.Transients.detect(await adapter.file.audioData)
                }
            }
            return {adapter}
        }))
        return () => tasks.forEach(({adapter, transients}) => {
            const optPitchStretch = adapter.asPlayModePitchStretch
            const boxGraph = adapter.box.graph
            const timeStretch = AudioTimeStretchBox.create(boxGraph, UUID.generate())
            adapter.box.playMode.refer(timeStretch)
            if (optPitchStretch.nonEmpty()) {
                const pitchStretch = optPitchStretch.unwrap()
                if (pitchStretch.box.pointerHub.isEmpty()) {
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
                AudioContentHelpers.addDefaultWarpMarkers(boxGraph, timeStretch, adapter.duration, adapter.file.endInSeconds)
            }
            if (isDefined(transients)) {
                const markersField = adapter.file.box.transientMarkers
                transients.forEach(position => TransientMarkerBox.create(boxGraph, UUID.generate(), box => {
                    box.owner.refer(markersField)
                    box.position.setValue(position)
                }))
            }
            switchTimeBaseToMusical(adapter)
        })
    }

    const switchTimeBaseToSeconds = ({box, file, timeBase}: AudioContentBoxAdapter): void => {
        if (timeBase === TimeBase.Seconds) {return}
        // Reset to 100% playback speed (original file speed)
        box.timeBase.setValue(TimeBase.Seconds)
        box.duration.setValue(file.endInSeconds)
        box.accept({
            visitAudioRegionBox: (box: AudioRegionBox) => {
                box.loopOffset.setValue(0)
                box.loopDuration.setValue(file.endInSeconds)
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