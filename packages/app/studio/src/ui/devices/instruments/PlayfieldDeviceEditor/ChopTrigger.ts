import {int, isDefined, Option, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {InstrumentFactories, PlayfieldDeviceBoxAdapter, Sample} from "@opendaw/studio-adapters"
import {StudioService} from "@/service/StudioService"
import {AnyDragData} from "@/ui/AnyDragData"
import {ChopDialog} from "./ChopDialog"

export namespace ChopTrigger {
    export const DEFAULT_START_KEY: int = 60

    export const forSample = async (service: StudioService,
                                    deviceAdapter: PlayfieldDeviceBoxAdapter,
                                    sample: Sample,
                                    startKey: int): Promise<void> => {
        if (!service.hasProfile) {return}
        const uuid = UUID.parse(sample.uuid)
        const {status, value: audioData, error} = await Promises.tryCatch(service.sampleManager.getAudioData(uuid))
        if (status === "rejected") {console.warn(error); return}
        const peaksOption = service.sampleManager.getOrCreate(uuid).peaks
        if (peaksOption.isEmpty()) {return}
        const {boxGraph} = service.project
        ChopDialog.open({
            service,
            deviceAdapter,
            peaks: peaksOption.unwrap(),
            audioData,
            resolveFile: () => boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() =>
                AudioFileBox.create(boxGraph, uuid, box => {
                    box.fileName.setValue(sample.name)
                    box.endInSeconds.setValue(sample.duration)
                })),
            startKey,
            bpmHint: sample.bpm
        })
    }

    export const intoNewPlayfield = (service: StudioService, sample: Sample): void => {
        if (!service.hasProfile) {return}
        const {project} = service
        const instrumentBox = project.editing.modify(() => {
            const {instrumentBox} = project.api.createInstrument(InstrumentFactories.Playfield)
            instrumentBox.label.setValue(sample.name)
            return instrumentBox
        }).unwrapOrNull()
        if (!isDefined(instrumentBox)) {return}
        forSample(service, project.boxAdapters.adapterFor(instrumentBox, PlayfieldDeviceBoxAdapter),
            sample, DEFAULT_START_KEY)
    }

    export const resolveSample = async (service: StudioService, data: AnyDragData): Promise<Option<Sample>> => {
        if (data.type === "sample") {return Option.wrap(data.sample)}
        if (data.type === "file") {
            if (!isDefined(data.file)) {return Option.None}
            const {status, value, error} = await Promises.tryCatch(service.sampleService.importFile({
                name: data.file.name,
                arrayBuffer: await data.file.arrayBuffer()
            }))
            if (status === "rejected") {console.warn(error); return Option.None}
            service.project.trackUserCreatedSample(UUID.parse(value.uuid))
            return Option.wrap(value)
        }
        return Option.None
    }
}
