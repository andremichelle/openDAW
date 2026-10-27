import {
    Arrays,
    DefaultObservableValue,
    EmptyProcedure,
    Errors,
    int,
    isDefined,
    Option,
    Procedure,
    RuntimeNotifier,
    RuntimeSignal,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {AudioData, dbToGain, ppqn, RegionCollection, WavFile} from "@opendaw/lib-dsp"
import {Promises} from "@opendaw/lib-runtime"
import {
    AnyRegionBoxAdapter,
    AudioRegionBoxAdapter,
    AudioUnitBoxAdapter,
    ExportConfiguration,
    ExportStemConfiguration,
    InstrumentFactories,
    NoteRegionBoxAdapter,
    Sample
} from "@opendaw/studio-adapters"
import {AudioFileBox, AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {AudioContentFactory, AudioFileBoxFactory, Project} from "./project"
import {OfflineEngineRenderer} from "./OfflineEngineRenderer"
import {SampleService, SampleStorage} from "./samples"
import {ResourceStructure, ResourceStructureFolder} from "./StructureFile"
import {ProjectSignals} from "./project/ProjectSignals"
import {RenderQuantum} from "./RenderQuantum"
import {Workers} from "./Workers"

export namespace AudioBounce {
    export type Tap = "pre-fx" | "pre-fader" | "post-fader"
    export type Options = { tap: Tap, tail: boolean, merge: boolean, loop: boolean }
    export type BounceableRegion = NoteRegionBoxAdapter | AudioRegionBoxAdapter
    export type Job = {
        audioUnitBox: AudioUnitBox
        regions: ReadonlyArray<BounceableRegion>
        start: ppqn
        end: ppqn
        label: string
        loop: boolean
    }
    export type Span = { skipFrames: int, numFrames: int, tail: boolean }

    export const FolderName = "Bounces"
    export const MaxTailSeconds = 30
    export const TailSilenceSeconds = 1
    export const SilenceThreshold = dbToGain(-72.0)
    export const ChunkFrames = RenderQuantum * 375
    export const DefaultOptions: Options = {tap: "pre-fader", tail: false, merge: false, loop: false}

    export const isBounceable = (region: AnyRegionBoxAdapter): region is BounceableRegion =>
        region.type === "note-region" || region.type === "audio-region"

    export const canBounce = (regions: ReadonlyArray<AnyRegionBoxAdapter>): boolean =>
        regions.some(region => isBounceable(region) && region.trackBoxAdapter.nonEmpty())

    export const canMerge = (regions: ReadonlyArray<AnyRegionBoxAdapter>): boolean =>
        collectJobs(regions, true, false).some(job => job.regions.length > 1)

    // A loop job renders one pass of the region loop, starting at the region position.
    export const collectJobs = (regions: ReadonlyArray<AnyRegionBoxAdapter>,
                                merge: boolean, loop: boolean): ReadonlyArray<Job> => {
        const groups = UUID.newSet<{ uuid: UUID.Bytes, unit: AudioUnitBox, regions: Array<BounceableRegion> }>(
            entry => entry.uuid)
        regions.filter(isBounceable).toSorted(RegionCollection.Comparator).forEach(region =>
            region.trackBoxAdapter.ifSome(({audioUnit}) =>
                groups.getOrCreate(audioUnit.address.uuid, uuid => ({uuid, unit: audioUnit, regions: []}))
                    .regions.push(region)))
        return groups.values().flatMap(({unit, regions}) => loop
            ? regions.map(region => ({
                audioUnitBox: unit, regions: [region], start: region.position,
                end: region.position + region.loopDuration, label: region.label, loop
            }))
            : merge
                ? [createJob(unit, regions)]
                : regions.map(region => createJob(unit, [region])))
    }

    const createJob = (audioUnitBox: AudioUnitBox, regions: ReadonlyArray<BounceableRegion>): Job => {
        const first = Arrays.getFirst(regions, "AudioBounce.createJob")
        return {
            audioUnitBox, regions,
            start: first.position,
            end: regions.reduce((max, region) => Math.max(max, region.complete), first.complete),
            label: first.label,
            loop: false
        }
    }

    export const stemConfiguration = (tap: Tap, fileName: string): ExportStemConfiguration => ({
        includeAudioEffects: true,
        includeSends: false,
        useInstrumentOutput: tap === "pre-fx",
        skipChannelStrip: tap === "pre-fader",
        fileName
    })

    export const exportConfiguration = (job: Job, tap: Tap): ExportConfiguration => ({
        stems: {[UUID.toString(job.audioUnitBox.address.uuid)]: stemConfiguration(tap, job.label)}
    })

    // Runs on a copy: the copy keeps every uuid, so the job's boxes are found by address.
    export const prepareCopy = (copy: Project, job: Job): void => {
        const keep = UUID.newSet<UUID.Bytes>(uuid => uuid)
        job.regions.forEach(region => keep.add(region.uuid))
        const {boxGraph, boxAdapters, rootBoxAdapter} = copy
        boxGraph.beginTransaction()
        rootBoxAdapter.audioUnits.adapters().forEach(unit => unit.box.solo.setValue(false))
        boxGraph.findBox(job.audioUnitBox.address.uuid).ifSome(box => {
            const unit = boxAdapters.adapterFor(box, AudioUnitBoxAdapter)
            unit.box.mute.setValue(false)
            unit.tracks.values().forEach(track => {
                track.box.enabled.setValue(true)
                track.regions.collection.asArray()
                    .filter(isBounceable)
                    .forEach(region => {
                        if (!keep.hasKey(region.uuid)) {
                            region.box.delete()
                            return
                        }
                        region.box.mute.setValue(false)
                        if (job.loop) {
                            region.box.loopOffset.setValue(0)
                            region.box.duration.setValue(region.box.loopDuration.getValue() * 2)
                        }
                    })
            })
        })
        boxGraph.endTransaction()
    }

    // The exact span is always kept, a tail only adds what is still audible after it.
    export const audibleLength = (frames: ReadonlyArray<Float32Array>, minLength: int, length: int,
                                  threshold: number = SilenceThreshold): int => {
        for (let index = length - 1; index >= minLength; index--) {
            if (frames.some(channel => Math.abs(channel[index]) > threshold)) {return index + 1}
        }
        return minLength
    }

    // Greedy: each span takes the first lane that is free at its start.
    export const assignLanes = (spans: ReadonlyArray<{ start: ppqn, end: ppqn }>): ReadonlyArray<int> => {
        const laneEnds: Array<ppqn> = []
        return spans.map(({start, end}) => {
            const free = laneEnds.findIndex(laneEnd => laneEnd <= start)
            const lane = free === -1 ? laneEnds.length : free
            laneEnds[lane] = end
            return lane
        })
    }

    export const fileInto = (structure: ResourceStructure, uuids: ReadonlyArray<UUID.String>): ResourceStructure => {
        const filed = new Set<UUID.String>()
        const collect = (folder: ResourceStructureFolder): void => {
            folder.uuids?.forEach(uuid => filed.add(uuid))
            folder.folders?.forEach(collect)
        }
        structure.folders.forEach(collect)
        const incoming = Array.from(new Set(uuids)).filter(uuid => !filed.has(uuid))
        if (incoming.length === 0) {return structure}
        const trash = structure.trash.filter(entry => !incoming.includes(entry.uuid))
        const hasFolder = structure.folders.some(folder => folder.name === FolderName)
        const folders = hasFolder
            ? structure.folders.map(folder => folder.name === FolderName
                ? {...folder, uuids: [...(folder.uuids ?? []), ...incoming]}
                : folder)
            : [...structure.folders, {name: FolderName, uuids: incoming}]
        return {...structure, folders, trash}
    }

    export type Rendered = { job: Job, audioData: AudioData, sample: Sample, modifier: () => AudioFileBox }

    export const bounce = async (project: Project,
                                 sampleService: SampleService,
                                 regions: ReadonlyArray<AnyRegionBoxAdapter>,
                                 options: Options,
                                 abortSignal?: AbortSignal): Promise<void> => {
        const jobs = collectJobs(regions, options.merge, options.loop)
        if (jobs.length === 0) {return}
        const abortController = new AbortController()
        if (isDefined(abortSignal)) {abortSignal.addEventListener("abort", () => abortController.abort())}
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Bouncing...",
            progress,
            cancel: () => abortController.abort()
        })
        const sampleRate = sampleService.audioContext.sampleRate
        const bpm = project.timelineBox.bpm.getValue()
        const result = await Promises.tryCatch((async () => {
            const rendered: Array<Rendered> = []
            for (const [index, job] of jobs.entries()) {
                dialog.message = `${job.label.length > 0 ? job.label : "Region"} (${index + 1} of ${jobs.length})`
                const audioData = await render(project, job, options, sampleRate,
                    value => progress.setValue((index + value) / jobs.length), abortController.signal)
                const sample = await sampleService.importFile({
                    name: sampleName(project, job),
                    bpm,
                    arrayBuffer: WavFile.encodeFloats(audioData)
                })
                const modifier = await AudioFileBoxFactory.createModifier(
                    Workers.Transients, project.boxGraph, audioData, UUID.parse(sample.uuid), sample.name)
                rendered.push({job, audioData, sample, modifier})
            }
            return rendered
        })())
        dialog.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Bounce failed.", icon: "Warning"})
            }
            return
        }
        const rendered = result.value
        await fileSamples(rendered.map(({sample}) => sample.uuid))
        applyEdit(project, rendered)
    }

    const sampleName = (project: Project, job: Job): string => {
        const unitLabel = project.boxAdapters.adapterFor(job.audioUnitBox, AudioUnitBoxAdapter).label
        return job.label.length > 0 ? `${unitLabel} ${job.label}` : unitLabel
    }

    const render = async (project: Project, job: Job, {tap, tail}: Options, sampleRate: int,
                          onProgress: Procedure<unitValue>, abortSignal: AbortSignal): Promise<AudioData> => {
        const copy = project.copy()
        prepareCopy(copy, job)
        const span = renderSpan(project, job, tail, sampleRate)
        const renderer = await OfflineEngineRenderer.create(copy, Option.wrap(exportConfiguration(job, tap)), sampleRate)
        const result = await Promises.tryCatch((async () => {
            await renderer.waitForLoading()
            renderer.setPosition(job.start)
            await renderer.play()
            await renderer.waitForLoading()
            return renderFrames(count => renderer.step(count), span, sampleRate, onProgress, abortSignal)
        })())
        renderer.terminate()
        if (result.status === "rejected") {return Promise.reject(result.error)}
        return result.value
    }

    export const frameCount = (project: Project, from: ppqn, to: ppqn, sampleRate: int): int =>
        Math.max(1, Math.round(project.tempoMap.intervalToSeconds(from, to) * sampleRate))

    // A loop renders two passes and keeps the second, so effects ring into the start as they do when looping.
    export const renderSpan = (project: Project, job: Job, tail: boolean, sampleRate: int): Span => job.loop
        ? {
            skipFrames: frameCount(project, job.start, job.end, sampleRate),
            numFrames: frameCount(project, job.end, job.end + (job.end - job.start), sampleRate),
            tail: false
        }
        : {skipFrames: 0, numFrames: frameCount(project, job.start, job.end, sampleRate), tail}

    export type Step = (count: int) => Promise<ReadonlyArray<Float32Array>>

    // Steps in whole chunks (a step drops the rest of its last quantum) and cuts to the exact span or the audible tail.
    export const renderFrames = async (step: Step, {skipFrames, numFrames, tail}: Span, sampleRate: int,
                                       onProgress: Procedure<unitValue> = EmptyProcedure,
                                       abortSignal?: AbortSignal): Promise<AudioData> => {
        const maxFrames = skipFrames + numFrames + (tail ? MaxTailSeconds * sampleRate : 0)
        const minLength = skipFrames + numFrames
        const frames: ReadonlyArray<Float32Array> = Arrays.create(() => new Float32Array(maxFrames), 2)
        let rendered = 0
        while (rendered < maxFrames) {
            if (abortSignal?.aborted === true) {return Promise.reject(Errors.AbortError)}
            const channels = await step(ChunkFrames)
            const count = Math.min(ChunkFrames, maxFrames - rendered)
            frames.forEach((channel, index) => channel.set(channels[index].subarray(0, count), rendered))
            rendered += count
            onProgress(Math.min(1.0, rendered / minLength))
            if (rendered - audibleLength(frames, minLength, rendered) >= TailSilenceSeconds * sampleRate) {break}
        }
        const length = (tail ? audibleLength(frames, minLength, rendered) : minLength) - skipFrames
        const audioData = AudioData.create(sampleRate, length, 2)
        frames.forEach((channel, index) => audioData.frames[index].set(channel.subarray(skipFrames, skipFrames + length)))
        return audioData
    }

    const fileSamples = async (uuids: ReadonlyArray<UUID.String>): Promise<void> => {
        const {structure} = SampleStorage.get()
        const current = (await structure.load()).unwrapOrElse(() => ({version: 1, folders: [], trash: []}))
        const next = fileInto(current, uuids)
        if (next === current) {return}
        await structure.save(next)
        RuntimeSignal.dispatch(ProjectSignals.StorageUpdated)
    }

    export const applyEdit = (project: Project, rendered: ReadonlyArray<Rendered>): void => {
        const {api, boxAdapters, boxGraph, editing, tempoMap} = project
        editing.modify(() => {
            const byUnit = UUID.newSet<{ uuid: UUID.Bytes, unit: AudioUnitBox, items: Array<Rendered> }>(
                entry => entry.uuid)
            rendered.forEach(item => byUnit.getOrCreate(item.job.audioUnitBox.address.uuid,
                uuid => ({uuid, unit: item.job.audioUnitBox, items: []})).items.push(item))
            byUnit.values().forEach(({unit, items}) => {
                const unitLabel = boxAdapters.adapterFor(unit, AudioUnitBoxAdapter).label
                const {audioUnitBox, trackBox} = api.createInstrument(InstrumentFactories.Tape,
                    {name: `${unitLabel} Bounce`})
                api.placeAudioUnit(audioUnitBox, unit.index.getValue() + 1)
                const sorted = items.toSorted((a, b) => a.job.start - b.job.start)
                const spans = sorted.map(({job, audioData}) => {
                    if (job.loop) {return {start: job.start, end: Arrays.getFirst(job.regions, "loop region").complete}}
                    const startSeconds = tempoMap.ppqnToSeconds(job.start)
                    const seconds = audioData.numberOfFrames / audioData.sampleRate
                    return {start: job.start, end: tempoMap.secondsToPPQN(startSeconds + seconds)}
                })
                const tracks: Array<TrackBox> = [trackBox]
                assignLanes(spans).forEach((lane, index) => {
                    const {job, sample, modifier} = sorted[index]
                    while (tracks.length <= lane) {tracks.push(api.createAudioTrack(audioUnitBox))}
                    const regionBox = AudioContentFactory.createNotStretchedRegion({
                        boxGraph,
                        targetTrack: tracks[lane],
                        audioFileBox: modifier(),
                        sample,
                        position: job.start,
                        name: job.label
                    })
                    if (job.loop) {
                        const source = Arrays.getFirst(job.regions, "loop region")
                        regionBox.duration.setValue(tempoMap.intervalToSeconds(source.position, source.complete))
                        regionBox.loopOffset.setValue(source.loopOffset)
                    }
                    job.regions.forEach(region => region.box.mute.setValue(true))
                    project.trackUserCreatedSample(UUID.parse(sample.uuid))
                })
            })
        })
    }
}
