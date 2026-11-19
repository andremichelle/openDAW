import {AudioSplice, EventCollection, ppqn, TempoMap, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {EmptyProcedure, isDefined, isInstanceOf, Option, Provider, RuntimeNotifier, SortedSet, tryCatch, UUID} from "@opendaw/lib-std"
import {Box, PointerField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
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
type ReverseEdit = {
    item: AudioItem, file: AudioFileBoxAdapter, range: SourceRange, bounds: SourceRange, create: Provider<AudioFileBox>
}

export namespace AudioReversals {
    export const reverseSelection = (service: StudioService,
                                     items: ReadonlyArray<AnyClipBoxAdapter | AnyRegionBoxAdapter>): boolean => {
        const audioItems = items.filter(item => item.type === "audio-clip" || item.type === "audio-region")
        if (audioItems.length === 0) {return false}
        reverse(service, audioItems).catch(console.warn)
        return true
    }

    const warpOf = (item: AudioItem): Option<EventCollection<WarpMarkerBoxAdapter>> =>
        item.optWarpMarkers.flatMap(markers => markers.length() >= 2 ? Option.wrap(markers) : Option.None)

    const sourceRange = (item: AudioItem, tempoMap: TempoMap): SourceRange => {
        const wraps = item.type === "audio-region" && item.loopOffset + item.duration > item.loopDuration
        const start = item.type === "audio-region" && !wraps ? item.loopOffset : 0
        const end = item.type === "audio-region" && wraps ? item.loopDuration : start + item.duration
        const origin = item.type === "audio-region" ? item.offset : 0
        const offset = item.waveformOffset.getValue()
        const warp = warpOf(item)
        const secondsAt = (position: number): number => offset + warp.mapOr(
            markers => TransientMarkerUtils.unitsToSeconds(position, markers),
            tempoMap.intervalToSeconds(origin, origin + position))
        return {start, end, from: secondsAt(start), to: secondsAt(end)}
    }

    const clampedBounds = (item: AudioItem, range: SourceRange, from: number, to: number): SourceRange => {
        const offset = item.waveformOffset.getValue()
        return warpOf(item).match({
            none: () => ({...range, from, to}),
            some: markers => ({
                start: from > range.from ? Math.ceil(TransientMarkerUtils.secondsToUnits(from - offset, markers)) : range.start,
                end: to < range.to ? Math.floor(TransientMarkerUtils.secondsToUnits(to - offset, markers)) : range.end,
                from, to
            })
        })
    }

    const mirrorWarpMarkers = (target: AudioPlayMode["box"], source: EventCollection<WarpMarkerBoxAdapter>,
                               {start, end}: SourceRange): void => {
        const markers: ReadonlyArray<WarpMarkerBoxAdapter> = source.asArray().slice()
        if (markers.length < 2) {return}
        const from = TransientMarkerUtils.unitsToSeconds(start, source)
        const to = TransientMarkerUtils.unitsToSeconds(end, source)
        const inside = (position: ppqn): boolean => position > start && position < end
        const createMarker = (position: ppqn, seconds: number) => WarpMarkerBox.create(target.graph, UUID.generate(), box => {
            box.owner.refer(target.warpMarkers)
            box.position.setValue(position)
            box.seconds.setValue(seconds)
        })
        if (!markers.some(({position}) => position === start)) {createMarker(start, from)}
        if (!markers.some(({position}) => position === end)) {createMarker(end, to)}
        target.warpMarkers.pointerHub.incoming().forEach(({box}) => {
            if (isInstanceOf(box, WarpMarkerBox) && inside(box.position.getValue())) {box.delete()}
        })
        markers.filter(({position}) => inside(position))
            .forEach(({position, seconds}) => createMarker(start + end - position, from + to - seconds))
    }

    const usersOf = (box: Box): ReadonlyArray<PointerField> => box.pointerHub.incoming()
        .filter(pointer => pointer.targetAddress.mapOr(address => address.equals(box.address), false))

    const sameBounds = (left: SourceRange, right: SourceRange): boolean =>
        left.start === right.start && left.end === right.end

    const applyWarp = (mode: AudioPlayMode, edits: ReadonlyArray<ReverseEdit>): void => {
        const first = edits[0]
        if (usersOf(mode.box).length === edits.length && edits.every(edit => sameBounds(edit.bounds, first.bounds))) {
            mirrorWarpMarkers(mode.box, mode.warpMarkers, first.bounds)
            return
        }
        edits.forEach(({item, bounds}) => {
            const copy = mode.clone()
            item.box.playMode.refer(copy)
            mirrorWarpMarkers(copy, mode.warpMarkers, bounds)
        })
        if (usersOf(mode.box).length === 0) {mode.box.delete()}
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
                const bounds = clampedBounds(item, range, Math.max(range.from, 0),
                    Math.min(range.to, audio.numberOfFrames / audio.sampleRate))
                const from = Math.round(bounds.from * audio.sampleRate)
                const to = Math.round(bounds.to * audio.sampleRate)
                if (to - from <= 1) {continue}
                const key: ReverseKey = {uuid: file.uuid, from, to}
                const existing = reversed.opt(key)
                if (existing.nonEmpty()) {
                    edits.push({item, file, range, bounds, create: existing.unwrap().create})
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
                edits.push({item, file, range, bounds, create})
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
            editing.modify(() => {
                const valid = result.value.filter(({item, file, range, bounds}) => {
                    const {box} = item
                    if (!boxGraph.findBox(box.address.uuid).contains(box)
                        || !box.file.targetVertex.map(vertex => vertex.box).contains(file.box)) {return false}
                    const current = sourceRange(item, tempoMap)
                    return range.from === current.from && range.to === current.to
                        && sameBounds(bounds, clampedBounds(item, current, bounds.from, bounds.to))
                })
                const byMode = new Map<AudioPlayMode, Array<ReverseEdit>>()
                valid.forEach(edit => {
                    const {item: target, file, create} = edit
                    const reversed = create()
                    project.trackUserCreatedSample(reversed.address.uuid)
                    target.box.file.refer(reversed)
                    if (file.box.pointerHub.filter(Pointers.AudioFile).length === 0) {file.box.delete()}
                    target.observableOptPlayMode.ifSome(mode => {
                        if (mode.warpMarkers.length() < 2) {return}
                        const group = byMode.get(mode)
                        if (isDefined(group)) {group.push(edit)} else {byMode.set(mode, [edit])}
                    })
                })
                byMode.forEach((edits, mode) => applyWarp(mode, edits))
            })
        })
        for (const uuid of imported) {
            if (boxGraph.findBox(uuid).isEmpty()) {SampleGarbage.mark(uuid).catch(console.warn)}
        }
        if (applied.status === "failure") {throw applied.error}
    }
}
