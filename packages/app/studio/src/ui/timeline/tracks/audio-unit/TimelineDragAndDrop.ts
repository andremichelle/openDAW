import {isDefined, Nullable, Option, panic, RuntimeNotifier, UUID} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {AudioFileBox} from "@moises-ai/studio-boxes"
import {InstrumentFactories, Sample, TrackBoxAdapter, TrackType} from "@moises-ai/studio-adapters"
import {AudioFileBoxFactory, Project, Workers} from "@moises-ai/studio-core"
import {ClipCaptureTarget} from "@/ui/timeline/tracks/audio-unit/clips/ClipCapturing.ts"
import {AnyDragData} from "@/ui/AnyDragData.ts"
import {ElementCapturing} from "@/ui/canvas/capturing.ts"
import {StudioService} from "@/service/StudioService"
import {RegionCaptureTarget} from "./regions/RegionCapturing"

export type CreateParameters = {
    event: DragEvent
    trackBoxAdapter: TrackBoxAdapter
    audioFileBox: AudioFileBox
    sample: Sample
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
        if (target?.type === "clip" && target.clip.trackBoxAdapter.unwrap().type !== TrackType.Audio) {
            return Option.None
        }
        if (target?.type === "region" && target.region.trackBoxAdapter.unwrap().type !== TrackType.Audio) {
            return Option.None
        }
        if (data.type !== "sample" && data.type !== "instrument" && data.type !== "file") {
            return Option.None
        }
        return Option.wrap(target ?? "instrument")
    }

    async drop(event: DragEvent, data: AnyDragData) {
        const optDrop = this.canDrop(event, data)
        if (optDrop.isEmpty()) {return}
        const drop = optDrop.unwrap()
        const {boxAdapters, boxGraph, editing} = this.project
        let sample: Sample
        if (data.type === "sample") {
            sample = data.sample
        } else if (data.type === "file") {
            const file = data.file
            if (!isDefined(file)) {return}
            const {status, value, error} = await Promises.tryCatch(file.arrayBuffer()
                .then(arrayBuffer => this.#service.sampleService.importFile({name: file.name, arrayBuffer})))
            if (status === "rejected") {
                console.warn(error)
                return
            }
            sample = value
        } else if (data.type === "instrument") {
            editing.modify(() => this.project.api.createAnyInstrument(InstrumentFactories[data.device]))
            return
        } else {
            return
        }
        const {uuid: uuidAsString, name} = sample
        const uuid = UUID.parse(uuidAsString)
        const audioDataResult = await Promises.tryCatch(this.#service.sampleManager.getAudioData(uuid))
        if (audioDataResult.status === "rejected") {
            console.warn("Failed to load sample:", audioDataResult.error)
            await RuntimeNotifier.info({headline: "Sample Error", message: `Failed to load sample '${name}'.`})
            return
        }
        const audioFileBoxResult = await Promises.tryCatch(AudioFileBoxFactory
            .createModifier(Workers.Transients, boxGraph, audioDataResult.value, uuid, name))
        if (audioFileBoxResult.status === "rejected") {
            console.warn("Failed to create audio file:", audioFileBoxResult.error)
            await RuntimeNotifier.info({headline: "Sample Error", message: `Failed to process sample '${name}'.`})
            return
        }
        const audioFileBoxFactory = audioFileBoxResult.value
        editing.modify(() => {
            let trackBoxAdapter: TrackBoxAdapter
            if (drop === "instrument") {
                trackBoxAdapter = boxAdapters
                    .adapterFor(this.project.api.createInstrument(InstrumentFactories.Tape).trackBox, TrackBoxAdapter)
            } else if (drop?.type === "track") {
                trackBoxAdapter = drop.track.trackBoxAdapter
            } else if (drop?.type === "clip") {
                trackBoxAdapter = drop.clip.trackBoxAdapter.unwrap()
            } else if (drop?.type === "region") {
                trackBoxAdapter = drop.region.trackBoxAdapter.unwrap()
            } else {
                return panic("Illegal State")
            }
            const audioFileBox: AudioFileBox = audioFileBoxFactory()
            this.handleSample({event, trackBoxAdapter, audioFileBox, sample})
        })
    }

    abstract handleSample({event, trackBoxAdapter, audioFileBox, sample}: CreateParameters): void
}