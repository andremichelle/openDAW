import {DefaultObservableValue, isDefined, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, PresetDecoder} from "@opendaw/studio-adapters"
import {AudioUnitInsertion, PresetSource, PresetStorage} from "@opendaw/studio-core"
import {OpenPresetAPI} from "@/opendaw-api"
import {NewInstrumentRegion} from "@/ui/timeline/NewInstrumentRegion"
import type {StudioService} from "@/service/StudioService"

export namespace PresetApplication {
    export const loadBytes = (uuid: UUID.String, source: PresetSource): Promise<ArrayBuffer> => {
        if (source === "user") {return PresetStorage.load(UUID.parse(uuid))}
        const progress = new DefaultObservableValue(0.0)
        const controller = new AbortController()
        const dialog = RuntimeNotifier.progress({
            headline: "Downloading Preset",
            progress,
            cancel: () => controller.abort()
        })
        return OpenPresetAPI.get().load(UUID.parse(uuid), value => progress.setValue(value), controller.signal)
            .finally(() => dialog.terminate())
    }

    // without a progress dialog
    export const fetchBytes = (uuid: UUID.String, source: PresetSource): Promise<ArrayBuffer> =>
        source === "user"
            ? PresetStorage.load(UUID.parse(uuid))
            : OpenPresetAPI.get().load(UUID.parse(uuid))

    export const createNewAudioUnitFromRack = async (service: StudioService,
                                                     uuid: UUID.String,
                                                     source: PresetSource,
                                                     insertion: AudioUnitInsertion = service.project.api.insertionAfterEditing()): Promise<void> => {
        const bytes = await loadBytes(uuid, source)
        const {project} = service
        project.editing.modify(() => {
            const imported = project.api.importAudioUnitsAt(bytes, insertion)
            const first = imported.at(0)
            if (isDefined(first)) {
                project.userEditingManager.audioUnit.edit(first.editing)
                NewInstrumentRegion.create(project, service.timeline.snapping, first)
            }
        })
        project.loadScriptDevices()
    }

    export const createNewAudioUnitFromInstrument = async (service: StudioService,
                                                           uuid: UUID.String,
                                                           deviceKey: InstrumentFactories.Keys,
                                                           source: PresetSource,
                                                           insertion: AudioUnitInsertion = service.project.api.insertionAfterEditing()): Promise<void> => {
        const bytes = await loadBytes(uuid, source)
        const {project} = service
        const factory = InstrumentFactories.Named[deviceKey]
        project.editing.modify(() => {
            const product = project.api.createInstrumentAt(factory, insertion)
            const attempt = PresetDecoder.replaceAudioUnit(
                bytes, product.audioUnitBox,
                {keepMIDIEffects: true, keepAudioEffects: true})
            if (attempt.isFailure()) {
                RuntimeNotifier.notify({message: "Cannot apply preset.", icon: "Warning"})
            } else {
                NewInstrumentRegion.create(project, service.timeline.snapping, product.audioUnitBox)
            }
        })
        project.loadScriptDevices()
    }
}
