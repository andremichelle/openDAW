import {isAbsent, isNotNull, Nullable, Option, panic, RuntimeNotifier, UUID} from "@opendaw/lib-std"
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

    async drop(event: DragEvent, data: AnyDragData) {
        const optDrop = this.canDrop(event, data)
        if (optDrop.isEmpty()) {return}
        const drop = optDrop.unwrap()
        const project = this.project
        const {boxAdapters, boxGraph, editing, api} = project
        let aborted = false
        const subscription = this.#service.projectProfileService.subscribe(() => {aborted = true})
        let sample: Sample
        let sampleType: "sample" | "file"
        if (data.type === "sample") {
            sample = data.sample
            sampleType = "sample"
        } else if (data.type === "file") {
            const file = data.file
            if (isAbsent(file)) {subscription.terminate(); return}
            const {status, value, error} = await Promises.tryCatch(file.arrayBuffer()
                .then(arrayBuffer => this.#service.sampleService.importFile({name: file.name, arrayBuffer})))
            if (aborted) {subscription.terminate(); return}
            if (status === "rejected") {
                console.warn(error)
                subscription.terminate()
                return
            }
            project.trackUserCreatedSample(UUID.parse(value.uuid))
            sample = value
            sampleType = "file"
        } else if (data.type === "instrument") {
            subscription.terminate()
            const factoryKey = data.device
            if (factoryKey !== null) {
                editing.modify(() => api.createAnyInstrument(InstrumentFactories[factoryKey]))
            }
            return
        } else if (data.type === "preset") {
            subscription.terminate()
            if (data.category === "audio-unit") {
                PresetApplication.createNewAudioUnitFromRack(project, data.uuid, data.source)
                    .catch(console.warn)
            } else if (data.category === "instrument" && isNotNull(data.device)) {
                PresetApplication.createNewAudioUnitFromInstrument(
                    project, data.uuid, data.device, data.source).catch(console.warn)
            }
            return
        } else {
            subscription.terminate()
            return
        }
        const {uuid: uuidAsString, name} = sample
        const uuid = UUID.parse(uuidAsString)
        const audioDataResult = await Promises.tryCatch(this.#service.sampleManager.getAudioData(uuid))
        if (aborted) {subscription.terminate(); return}
        if (audioDataResult.status === "rejected") {
            console.warn("Failed to load sample:", audioDataResult.error)
            subscription.terminate()
            await RuntimeNotifier.info({headline: "Sample Error", message: `Failed to load sample '${name}'.`})
            return
        }
        const audioFileBoxResult = await Promises.tryCatch(AudioFileBoxFactory
            .createModifier(Workers.Transients, boxGraph, audioDataResult.value, uuid, name))
        if (aborted) {subscription.terminate(); return}
        if (audioFileBoxResult.status === "rejected") {
            console.warn("Failed to create audio file:", audioFileBoxResult.error)
            subscription.terminate()
            await RuntimeNotifier.info({headline: "Sample Error", message: `Failed to process sample '${name}'.`})
            return
        }
        subscription.terminate()
        const audioFileBoxFactory = audioFileBoxResult.value
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