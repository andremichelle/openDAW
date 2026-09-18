import {isNotNull, Nullable, Option, panic, Provider, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, Sample, TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {AudioFileBoxFactory, ElementCapturing, Project, Workers} from "@opendaw/studio-core"
import {ClipCaptureTarget} from "@/ui/timeline/tracks/audio-unit/clips/ClipCapturing.ts"
import {AnyDragData} from "@/ui/AnyDragData.ts"
import {PresetApplication} from "@/ui/browse/PresetApplication"
import {StudioService} from "@/service/StudioService"
import {RegionCaptureTarget} from "./regions/RegionCapturing"

export type CreateParameters = {
    event: DragEvent
    trackBoxAdapter: TrackBoxAdapter
    audioFileBox: AudioFileBox
    sample: Sample
    type: "sample" | "file"
}

export type ResolvedSampleDrop = {
    sample: Sample
    type: "sample" | "file"
    audioFileBoxFactory: Provider<AudioFileBox>
}

export abstract class TimelineDragAndDrop<T extends (ClipCaptureTarget | RegionCaptureTarget)> {
    readonly #service: StudioService
    readonly #capturing: ElementCapturing<T>

    protected constructor(service: StudioService, capturing: ElementCapturing<T>) {
        this.#service = service
        this.#capturing = capturing
    }

    get project(): Project {return this.#service.project}
    get capturing(): ElementCapturing<T> {return this.#capturing}

    canDrop(event: DragEvent, data: AnyDragData): Option<T | "instrument"> {
        const target: Nullable<T> = this.#capturing.captureEvent(event)
        if (target?.type === "track" && target.track.trackBoxAdapter.type !== TrackType.Audio) {
            return Option.None
        }
        if (target?.type === "clip") {
            const adapter = target.clip.trackBoxAdapter
            if (adapter.isEmpty() || adapter.unwrap().type !== TrackType.Audio) {return Option.None}
        }
        if (target?.type === "region") {
            const adapter = target.region.trackBoxAdapter
            if (adapter.isEmpty() || adapter.unwrap().type !== TrackType.Audio) {return Option.None}
        }
        if (data.type !== "sample" && data.type !== "instrument" && data.type !== "file") {
            if (data.type === "preset"
                && (data.category === "instrument" || data.category === "audio-unit")) {
                return Option.wrap(target ?? "instrument")
            }
            return Option.None
        }
        return Option.wrap(target ?? "instrument")
    }

    // Resolve a sample/file drag to playable samples plus AudioFileBox factories (imports OS files, loads
    // the audio data, computes transients). Empty when the drag carries no sample or resolution failed.
    static async resolveSamples(service: StudioService, data: AnyDragData): Promise<ReadonlyArray<ResolvedSampleDrop>> {
        const project = service.project
        let aborted = false
        const subscription = service.projectProfileService.subscribe(() => {aborted = true})
        const collect = async (): Promise<ReadonlyArray<[Sample, "sample" | "file"]>> => {
            if (data.type === "sample") {return [[data.sample, "sample"]]}
            if (data.type !== "file") {return []}
            const imported = await service.sampleService.importFiles(data.files)
            if (aborted) {return []}
            imported.forEach(sample => project.trackUserCreatedSample(UUID.parse(sample.uuid)))
            return imported.map(sample => [sample, "file"])
        }
        const resolved: Array<ResolvedSampleDrop> = []
        for (const [sample, sampleType] of await collect()) {
            if (aborted) {break}
            const option = await TimelineDragAndDrop.#resolveAudio(service, sample, sampleType)
            if (aborted) {break}
            option.ifSome(value => resolved.push(value))
        }
        subscription.terminate()
        return aborted ? [] : resolved
    }

    static async #resolveAudio(service: StudioService,
                               sample: Sample,
                               sampleType: "sample" | "file"): Promise<Option<ResolvedSampleDrop>> {
        const {boxGraph} = service.project
        const {uuid: uuidAsString, name} = sample
        const uuid = UUID.parse(uuidAsString)
        const audioDataResult = await Promises.tryCatch(service.sampleManager.getAudioData(uuid))
        if (audioDataResult.status === "rejected") {
            console.warn("Failed to load sample:", audioDataResult.error)
            RuntimeNotifier.notify({message: `Failed to load sample '${name}'.`, icon: "Info"})
            return Option.None
        }
        const audioFileBoxResult = await Promises.tryCatch(AudioFileBoxFactory
            .createModifier(Workers.Transients, boxGraph, audioDataResult.value, uuid, name))
        if (audioFileBoxResult.status === "rejected") {
            console.warn("Failed to create audio file:", audioFileBoxResult.error)
            RuntimeNotifier.notify({message: `Failed to process sample '${name}'.`, icon: "Info"})
            return Option.None
        }
        return Option.wrap({sample, type: sampleType, audioFileBoxFactory: audioFileBoxResult.value})
    }

    async drop(event: DragEvent, data: AnyDragData) {
        const optDrop = this.canDrop(event, data)
        if (optDrop.isEmpty()) {return}
        const drop = optDrop.unwrap()
        const project = this.project
        const {boxAdapters, editing, api} = project
        if (data.type === "instrument") {
            const factoryKey = data.device
            if (factoryKey !== null) {
                editing.modify(() => api.createAnyInstrument(InstrumentFactories[factoryKey]))
            }
            return
        }
        if (data.type === "preset") {
            if (data.category === "audio-unit") {
                PresetApplication.createNewAudioUnitFromRack(project, data.uuid, data.source)
                    .catch(console.warn)
            } else if (data.category === "instrument" && isNotNull(data.device)) {
                PresetApplication.createNewAudioUnitFromInstrument(
                    project, data.uuid, data.device, data.source).catch(console.warn)
            }
            return
        }
        const resolved = await TimelineDragAndDrop.resolveSamples(this.#service, data)
        if (resolved.length === 0) {return}
        const createTapeTrack = (): TrackBoxAdapter => boxAdapters
            .adapterFor(api.createInstrument(InstrumentFactories.Tape).trackBox, TrackBoxAdapter)
        const targetTrack = (): Option<TrackBoxAdapter> => {
            if (drop === "instrument") {return Option.wrap(createTapeTrack())}
            if (drop?.type === "track") {return Option.wrap(drop.track.trackBoxAdapter)}
            if (drop?.type === "clip") {return drop.clip.trackBoxAdapter}
            if (drop?.type === "region") {return drop.region.trackBoxAdapter}
            return panic("Illegal State")
        }
        editing.modify(() => resolved.forEach(({sample, type: sampleType, audioFileBoxFactory}, index) =>
            (index === 0 ? targetTrack() : Option.wrap(createTapeTrack())).ifSome(trackBoxAdapter =>
                this.handleSample({event, trackBoxAdapter, audioFileBox: audioFileBoxFactory(), sample, type: sampleType}))))
    }

    abstract handleSample({event, trackBoxAdapter, audioFileBox, sample}: CreateParameters): void
}