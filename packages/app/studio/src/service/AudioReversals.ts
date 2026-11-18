import {AudioSplice, TempoMap, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {clamp, EmptyProcedure, isDefined, Option, Provider, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AnyClipBoxAdapter, AnyRegionBoxAdapter, AudioClipBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFileBoxFactory, SampleGarbage, Workers} from "@opendaw/studio-core"
import {AudioFileBox} from "@opendaw/studio-boxes"
import type {StudioService} from "@/service/StudioService"
import {TransientMarkerUtils} from "@/ui/timeline/editors/audio/TransientMarkerUtils"

type AudioItem = AudioClipBoxAdapter | AudioRegionBoxAdapter
type SourceRange = {from: number, to: number}

export namespace AudioReversals {
    export const revertSelection = (service: StudioService,
                                    items: ReadonlyArray<AnyClipBoxAdapter | AnyRegionBoxAdapter>): boolean => {
        const audioItems = items.filter(item => item.type === "audio-clip" || item.type === "audio-region")
        if (audioItems.length === 0) {return false}
        reverse(service, audioItems).catch(console.warn)
        return true
    }

    const sourceRange = (item: AudioItem, tempoMap: TempoMap): SourceRange => {
        const wraps = item.type === "audio-region" && item.loopOffset + item.duration > item.loopDuration
        const start = item.type === "audio-region" && !wraps ? item.loopOffset : 0
        const end = item.type === "audio-region" && wraps ? item.loopDuration : start + item.duration
        const origin = item.type === "audio-region" ? item.offset : 0
        const offset = item.waveformOffset.getValue()
        const warp = item.optWarpMarkers.flatMap(markers => markers.length() >= 2 ? Option.wrap(markers) : Option.None)
        const secondsAt = (position: number): number => offset + warp.mapOr(
            markers => TransientMarkerUtils.unitsToSeconds(position, markers),
            tempoMap.intervalToSeconds(origin, origin + position))
        return {from: secondsAt(start), to: secondsAt(end)}
    }

    export const reverse = async (service: StudioService, audioItems: ReadonlyArray<AudioItem>): Promise<void> => {
        const project = service.project
        const {boxGraph, editing, tempoMap} = project
        const targets = audioItems.flatMap(item => item.optFile.mapOr(file =>
            [{item, file, range: sourceRange(item, tempoMap)}], []))
        if (targets.length === 0) {return}
        const progress = RuntimeNotifier.progress({headline: "Reversing Audio..."})
        const imported: Array<UUID.Bytes> = []
        const result = await Promises.tryCatch((async () => {
            const reversed = new Map<string, Provider<AudioFileBox>>()
            const edits = []
            for (const {item, file, range} of targets) {
                const audio = await file.audioData
                const frameAt = (seconds: number): number =>
                    clamp(Math.round(seconds * audio.sampleRate), 0, audio.numberOfFrames)
                const from = frameAt(range.from)
                const to = frameAt(range.to)
                if (!(to - from > 1)) {continue}
                const key = `${UUID.toString(file.uuid)}/${from}/${to}`
                const existing = reversed.get(key)
                if (isDefined(existing)) {
                    edits.push({item, file, range, create: existing})
                    continue
                }
                const segment = AudioSplice.slice(audio, from, to)
                const reversedSegment = await Workers.SampleEffect.process(EmptyProcedure, "reverse", segment, [])
                const output = AudioSplice.splice(audio, from, to - from, reversedSegment)
                const uuid = UUID.generate()
                const bpm = file.getOrCreateLoader().meta.mapOr(meta => meta.bpm, 0)
                const name = `${file.fileName} (reversed)`
                const create = await AudioFileBoxFactory.createModifier(Workers.Transients, boxGraph, output, uuid, name)
                await service.sampleService.importFile({uuid, name, bpm, arrayBuffer: WavFile.encodeFloats(output)})
                imported.push(uuid)
                reversed.set(key, create)
                edits.push({item, file, range, create})
            }
            return edits
        })())
        progress.terminate()
        try {
            if (result.status === "rejected") {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Could not reverse audio.", icon: "Warning"})
                return
            }
            if (!service.optProject.contains(project)) {return}
            editing.modify(() => result.value.forEach(({item, file, range, create}) => {
                const {box} = item
                if (!boxGraph.findBox(box.address.uuid).contains(box)
                    || !box.file.targetVertex.map(vertex => vertex.box).contains(file.box)) {return}
                const current = sourceRange(item, tempoMap)
                if (range.from !== current.from || range.to !== current.to) {return}
                const reversed = create()
                project.trackUserCreatedSample(reversed.address.uuid)
                box.file.refer(reversed)
            }))
        } finally {
            for (const uuid of imported) {
                if (boxGraph.findBox(uuid).isEmpty()) {SampleGarbage.mark(uuid).catch(console.warn)}
            }
        }
    }
}
