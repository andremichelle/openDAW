import {AudioSplice, ppqn, TempoMap, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {clamp, EmptyProcedure, Option, Provider, RuntimeNotifier, SortedSet, tryCatch, UUID} from "@opendaw/lib-std"
import {AnyClipBoxAdapter, AnyRegionBoxAdapter, AudioClipBoxAdapter, AudioFileBoxAdapter, AudioPlayMode,
    AudioRegionBoxAdapter, WarpMarkerBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFileBoxFactory, SampleGarbage, Workers} from "@opendaw/studio-core"
import {AudioFileBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import type {StudioService} from "@/service/StudioService"
import {TransientMarkerUtils} from "@/ui/timeline/editors/audio/TransientMarkerUtils"

type AudioItem = AudioClipBoxAdapter | AudioRegionBoxAdapter
type SourceRange = {start: ppqn, end: ppqn, from: number, to: number}
type ReverseKey = {uuid: UUID.Bytes, from: number, to: number}
type ReversedSource = {key: ReverseKey, create: Provider<AudioFileBox>}
type ReverseEdit = {item: AudioItem, file: AudioFileBoxAdapter, range: SourceRange, create: Provider<AudioFileBox>}

export namespace AudioReversals {
    export const reverseSelection = (service: StudioService,
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
        return {start, end, from: secondsAt(start), to: secondsAt(end)}
    }

    const mirrorWarpMarkers = (mode: AudioPlayMode, {start, end}: SourceRange): void => {
        const {box: {graph, warpMarkers: owner}, warpMarkers} = mode
        const markers: ReadonlyArray<WarpMarkerBoxAdapter> = warpMarkers.asArray().slice()
        if (markers.length < 2) {return}
        const from = TransientMarkerUtils.unitsToSeconds(start, warpMarkers)
        const to = TransientMarkerUtils.unitsToSeconds(end, warpMarkers)
        const inner = markers.filter(({position}) => position > start && position < end)
        const mirrored = inner.map(({position, seconds}) => ({position: start + end - position, seconds: from + to - seconds}))
        const createMarker = (position: ppqn, seconds: number) => WarpMarkerBox.create(graph, UUID.generate(), box => {
            box.owner.refer(owner)
            box.position.setValue(position)
            box.seconds.setValue(seconds)
        })
        if (!markers.some(({position}) => position === start)) {createMarker(start, from)}
        if (!markers.some(({position}) => position === end)) {createMarker(end, to)}
        inner.forEach(marker => marker.box.delete())
        mirrored.forEach(({position, seconds}) => createMarker(position, seconds))
    }

    export const reverse = async (service: StudioService, audioItems: ReadonlyArray<AudioItem>): Promise<void> => {
        const project = service.project
        const {boxGraph, editing, tempoMap} = project
        const targets = audioItems.flatMap(item => item.optFile.mapOr(file =>
            [{item, file, range: sourceRange(item, tempoMap)}], []))
        if (targets.length === 0) {return}
        const progress = RuntimeNotifier.progress({headline: "Reversing Audio...", delayed: true})
        const imported: Array<UUID.Bytes> = []
        const result = await Promises.tryCatch((async () => {
            const reversed = new SortedSet<ReverseKey, ReversedSource>(entry => entry.key, (left, right) =>
                UUID.Comparator(left.uuid, right.uuid) || left.from - right.from || left.to - right.to)
            const edits: Array<ReverseEdit> = []
            for (const {item, file, range} of targets) {
                const audio = await file.audioData
                const frameAt = (seconds: number): number =>
                    clamp(Math.round(seconds * audio.sampleRate), 0, audio.numberOfFrames)
                const from = frameAt(range.from)
                const to = frameAt(range.to)
                if (to - from <= 1) {continue}
                const key: ReverseKey = {uuid: file.uuid, from, to}
                const existing = reversed.opt(key)
                if (existing.nonEmpty()) {
                    edits.push({item, file, range, create: existing.unwrap().create})
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
                reversed.add({key, create})
                edits.push({item, file, range, create})
            }
            return edits
        })())
        progress.terminate()
        const applied = tryCatch(() => {
            if (result.status === "rejected") {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Could not reverse audio.", icon: "Warning"})
                return
            }
            if (!service.optProject.contains(project)) {return}
            const mirroredPlayModes = new Set<AudioPlayMode>()
            editing.modify(() => result.value.forEach(({item, file, range, create}) => {
                const {box} = item
                if (!boxGraph.findBox(box.address.uuid).contains(box)
                    || !box.file.targetVertex.map(vertex => vertex.box).contains(file.box)) {return}
                const current = sourceRange(item, tempoMap)
                if (range.from !== current.from || range.to !== current.to) {return}
                const reversed = create()
                project.trackUserCreatedSample(reversed.address.uuid)
                box.file.refer(reversed)
                if (file.box.pointerHub.incoming().length === 0) {file.box.delete()}
                item.observableOptPlayMode.ifSome(mode => {
                    if (mirroredPlayModes.has(mode)) {return}
                    mirroredPlayModes.add(mode)
                    mirrorWarpMarkers(mode, range)
                })
            }))
        })
        for (const uuid of imported) {
            if (boxGraph.findBox(uuid).isEmpty()) {SampleGarbage.mark(uuid).catch(console.warn)}
        }
        if (applied.status === "failure") {throw applied.error}
    }
}
