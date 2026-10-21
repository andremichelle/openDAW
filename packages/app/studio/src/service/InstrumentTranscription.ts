import {AudioData} from "@opendaw/lib-dsp"
import {AudioClipBoxAdapter, AudioRegionBoxAdapter, InstrumentFactories} from "@opendaw/studio-adapters"
import {AudioUnitBox, NoteClipBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {DefaultObservableValue, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Project} from "@opendaw/studio-core"
import {AudioToMidiTiming} from "./AudioToMidiTiming"

export type TranscriptionSource = AudioClipBoxAdapter | AudioRegionBoxAdapter
export interface InstrumentNote {
    readonly start: number
    readonly end: number
    readonly pitch: number
    readonly velocity: number
    readonly program: number
    readonly instrument: string
    readonly isDrum: boolean
}
export type InstrumentAnalyzer = (data: AudioData, range: {start: number, end: number}, options: {
    signal: AbortSignal, progress: (value: number) => void, message: (value: string) => void
}) => Promise<ReadonlyArray<InstrumentNote>>

const running = new WeakSet<Project>()
export class InstrumentTranscription {
    static readonly isRunning = (project: Project): boolean => running.has(project)

    static readonly convert = async (project: Project, source: TranscriptionSource, analyze: InstrumentAnalyzer): Promise<void> => {
        if (running.has(project)) {return}
        running.add(project)
        const controller = new AbortController(), progressValue = new DefaultObservableValue(0)
        const progress = RuntimeNotifier.progress({headline: "Transcribing instruments", message: source.label,
            progress: progressValue, cancel: () => controller.abort()})
        let alive = true, changed = false, listening = false
        const lifecycle = project.spawn()
        lifecycle.own({terminate: () => {alive = false; controller.abort()}})
        const tempoSubscription = project.tempoMap.subscribe(() => {if (listening) {changed = true}})
        listening = true
        const watched = UUID.newSet<UUID.Bytes>(uuid => uuid)
        watched.add(source.uuid)
        source.optFile.ifSome(file => watched.add(file.uuid))
        source.observableOptPlayMode.ifSome(mode => {
            watched.add(mode.uuid)
            mode.warpMarkers.asArray().forEach(marker => watched.add(marker.uuid))
        })
        const updates = project.boxGraph.subscribeToAllUpdates({onUpdate: update => {
            const uuid = update.type === "new" || update.type === "delete" ? update.uuid : update.address.uuid
            if (watched.hasKey(uuid)) {changed = true}
            if (update.type === "new" || update.type === "pointer") {
                project.boxGraph.findBox(uuid).ifSome(box => {
                    if (box instanceof WarpMarkerBox && box.owner.targetVertex
                        .map(vertex => watched.hasKey(vertex.address.uuid)).unwrapOrElse(false)) {changed = true}
                })
            }
        }})
        try {
            const track = source.trackBoxAdapter.unwrap("Audio has no track"), file = source.file
            const duration = source.duration, position = source.type === "audio-region" ? source.position : 0
            const loopOffset = source.type === "audio-region" ? source.loopOffset : 0
            const loopDuration = source.type === "audio-region" ? source.loopDuration : duration
            const loops = loopOffset + duration > loopDuration
            let from = loops ? 0 : loopOffset, to = loops ? loopDuration : loopOffset + duration
            const timing = new AudioToMidiTiming(project.tempoMap, position - loopOffset, source.waveformOffset.getValue(),
                source.optWarpMarkers.map(markers => markers.asArray().map(({position, seconds}) => ({position, seconds})))
                    .unwrapOrElse([]))
            if (timing.markers.length >= 2) {
                from = Math.max(from, timing.markers[0].position)
                to = Math.min(to, timing.markers[timing.markers.length - 1].position)
            }
            const label = source.label || "Audio", hue = source.hue
            const clipIndex = source.type === "audio-clip" ? source.indexField.getValue() : 0
            const data = await file.audioData
            if (!alive || controller.signal.aborted) {return}
            if (changed) {throw new Error("Audio changed during transcription. Please try again.")}
            const range = {start: Math.max(0, timing.toSeconds(from)),
                end: Math.min(data.numberOfFrames / data.sampleRate, timing.toSeconds(to))}
            if (range.end <= range.start) {throw new Error("This clip's range contains no source audio")}
            const notes = await analyze(data, range, {signal: controller.signal,
                progress: value => progressValue.setValue(value), message: value => {progress.message = value}})
            if (!alive || controller.signal.aborted) {return}
            if (changed || !source.box.isAttached() || !track.box.isAttached()) {
                throw new Error("Audio changed during transcription. Please try again.")
            }
            const pitchShift = source.asPlayModeTimeStretch.map(mode => 12 * Math.log2(mode.playbackRate)).unwrapOrElse(0)
                + source.asPlayModeSignalsmith.map(mode => mode.transpose).unwrapOrElse(0)
            const groups = new Map<string, Array<{start: number, end: number, pitch: number, velocity: number}>>()
            for (const note of notes) {
                if (![note.start, note.end, note.pitch, note.velocity, note.program].every(Number.isFinite)
                    || note.end <= note.start || note.pitch < 0 || note.pitch > 127) {continue}
                const start = Math.max(from, timing.toPulses(note.start)), end = Math.min(to, timing.toPulses(note.end))
                if (end <= start) {continue}
                let shift = note.isDrum ? 0 : pitchShift
                if (!note.isDrum && source.asPlayModePitchStretch.nonEmpty()) {
                    const seconds = project.tempoMap.intervalToSeconds(position - loopOffset + start, position - loopOffset + end)
                    shift += 12 * Math.log2((note.end - note.start) / seconds)
                }
                const name = note.instrument || `MIDI Program ${note.program + 1}`
                let group = groups.get(name)
                if (group === undefined) {groups.set(name, group = [])}
                group.push({start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(end)),
                    pitch: Math.max(0, Math.min(127, Math.round(note.pitch + shift))), velocity: Math.max(0, Math.min(1, note.velocity))})
            }
            if (groups.size === 0) {
                RuntimeNotifier.notify({message: "No notes detected. Try cleaner audio or another clip.", icon: "Info"})
                return
            }
            project.editing.modify(() => {
                project.selection.deselectAll()
                let index = track.audioUnit.index.getValue() + 1
                let firstEditing: AudioUnitBox["editing"] | undefined
                for (const [instrument, notes] of groups) {
                    const name = `${label} (${instrument})`
                    // Neon provides immediate note audition; labels describe detection, not recreated timbres.
                    const product = project.api.createInstrument(InstrumentFactories.Neon, {name: instrument})
                    firstEditing ??= product.audioUnitBox.editing
                    project.api.placeAudioUnit(product.audioUnitBox, index++)
                    const owner = source.type === "audio-clip"
                        ? project.api.createNoteClip(product.trackBox, clipIndex, {name, hue})
                        : project.api.createNoteRegion({trackBox: product.trackBox, position,
                            duration: Math.max(1, Math.round(duration)), loopOffset: Math.round(loopOffset),
                            loopDuration: Math.max(1, Math.round(loopDuration)), name, hue})
                    if (owner instanceof NoteClipBox && source.type === "audio-clip") {
                        owner.duration.setValue(Math.max(1, Math.round(duration)))
                        owner.triggerMode.loop.setValue(source.box.triggerMode.loop.getValue())
                    }
                    for (const note of notes) {
                        project.api.createNoteEvent({owner, position: note.start, duration: note.end - note.start,
                            velocity: note.velocity, pitch: note.pitch})
                    }
                    project.selection.select(owner)
                    if (index === track.audioUnit.index.getValue() + 2) {project.userEditingManager.timeline.edit(owner)}
                }
                if (firstEditing !== undefined) {project.userEditingManager.audioUnit.edit(firstEditing)}
            })
        } catch (error) {
            if (alive && !controller.signal.aborted) {
                console.warn(error)
                RuntimeNotifier.notify({message: error instanceof Error ? error.message : "Instrument transcription failed.", icon: "Warning"})
            }
        } finally {
            updates.terminate()
            tempoSubscription.terminate()
            lifecycle.terminate()
            progress.terminate()
            running.delete(project)
        }
    }
}
