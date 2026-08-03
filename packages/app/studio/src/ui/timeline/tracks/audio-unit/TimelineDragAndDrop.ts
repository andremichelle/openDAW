import {isAbsent, isNotNull, Nullable, Option, panic, Provider, RuntimeNotifier, UUID} from "@opendaw/lib-std"
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

    // Resolve a sample/file drag to a playable sample plus an AudioFileBox factory (imports OS files, loads
    // the audio data, computes transients). `None` when the drag carries no sample or resolution failed.
    static async resolveSample(service: StudioService, data: AnyDragData): Promise<Option<ResolvedSampleDrop>> {
        const project = service.project
        const {boxGraph} = project
        let aborted = false
        const subscription = service.projectProfileService.subscribe(() => {aborted = true})
        let sample: Sample
        let sampleType: "sample" | "file"
        if (data.type === "sample") {
            sample = data.sample
            sampleType = "sample"
        } else if (data.type === "file") {
            const file = data.file
            if (isAbsent(file)) {subscription.terminate(); return Option.None}
            const {status, value, error} = await Promises.tryCatch(file.arrayBuffer()
                .then(arrayBuffer => service.sampleService.importFile({name: file.name, arrayBuffer})))
            if (aborted) {subscription.terminate(); return Option.None}
            if (status === "rejected") {
                console.warn(error)
                subscription.terminate()
                return Option.None
            }
            project.trackUserCreatedSample(UUID.parse(value.uuid))
            sample = value
            sampleType = "file"
        } else {
            subscription.terminate()
            return Option.None
        }
        const {uuid: uuidAsString, name} = sample
        const uuid = UUID.parse(uuidAsString)
        const audioDataResult = await Promises.tryCatch(service.sampleManager.getAudioData(uuid))
        if (aborted) {subscription.terminate(); return Option.None}
        if (audioDataResult.status === "rejected") {
            console.warn("Failed to load sample:", audioDataResult.error)
            subscription.terminate()
            RuntimeNotifier.notify({message: `Failed to load sample '${name}'.`, icon: "Info"})
            return Option.None
        }
        const audioFileBoxResult = await Promises.tryCatch(AudioFileBoxFactory
            .createModifier(Workers.Transients, boxGraph, audioDataResult.value, uuid, name))
        if (aborted) {subscription.terminate(); return Option.None}
        if (audioFileBoxResult.status === "rejected") {
            console.warn("Failed to create audio file:", audioFileBoxResult.error)
            subscription.terminate()
            RuntimeNotifier.notify({message: `Failed to process sample '${name}'.`, icon: "Info"})
            return Option.None
        }
        subscription.terminate()
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
        const optResolved = await TimelineDragAndDrop.resolveSample(this.#service, data)
        if (optResolved.isEmpty()) {return}
        const {sample, type: sampleType, audioFileBoxFactory} = optResolved.unwrap()
        editing.modify(() => {
            let trackBoxAdapter: TrackBoxAdapter
            if (drop === "instrument") {
                trackBoxAdapter = boxAdapters
                    .adapterFor(api.createInstrument(InstrumentFactories.Tape).trackBox, TrackBoxAdapter)
            } else if (drop?.type === "track") {
                trackBoxAdapter = drop.track.trackBoxAdapter
            } else if (drop?.type === "clip") {
                const clipTrack = drop.clip.trackBoxAdapter
                if (clipTrack.isEmpty()) {return}
                trackBoxAdapter = clipTrack.unwrap()
            } else if (drop?.type === "region") {
                const regionTrack = drop.region.trackBoxAdapter
                if (regionTrack.isEmpty()) {return}
                trackBoxAdapter = regionTrack.unwrap()
            } else {
                return panic("Illegal State")
            }
            const audioFileBox: AudioFileBox = audioFileBoxFactory()
            this.handleSample({event, trackBoxAdapter, audioFileBox, sample, type: sampleType})
        })
    }

    abstract handleSample({event, trackBoxAdapter, audioFileBox, sample}: CreateParameters): void
}