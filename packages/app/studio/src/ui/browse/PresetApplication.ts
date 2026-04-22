import {DefaultObservableValue, isDefined, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, PresetDecoder} from "@opendaw/studio-adapters"
import {OpenPresetAPI, PresetSource, PresetStorage, Project} from "@opendaw/studio-core"

export namespace PresetApplication {
    export const loadBytes = (uuid: UUID.String, source: PresetSource): Promise<ArrayBuffer> => {
        if (source === "user") {return PresetStorage.load(UUID.parse(uuid))}
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Downloading Preset", progress})
        return OpenPresetAPI.get().load(UUID.parse(uuid), value => progress.setValue(value))
            .finally(() => dialog.terminate())
    }

    export const createNewAudioUnitFromRack = async (project: Project,
                                                     uuid: UUID.String,
                                                     source: PresetSource): Promise<void> => {
        const bytes = await loadBytes(uuid, source)
        project.editing.modify(() => {
            const imported = PresetDecoder.decode(bytes, project.skeleton)
            const first = imported.at(0)
            if (isDefined(first)) {
                project.userEditingManager.audioUnit.edit(first.editing)
            }
        })
        project.loadScriptDevices()
    }

    export const createNewAudioUnitFromInstrument = async (project: Project,
                                                           uuid: UUID.String,
                                                           deviceKey: InstrumentFactories.Keys,
                                                           source: PresetSource): Promise<void> => {
        const bytes = await loadBytes(uuid, source)
        const factory = InstrumentFactories.Named[deviceKey]
        project.editing.modify(() => {
            const product = project.api.createAnyInstrument(factory)
            const attempt = PresetDecoder.replaceAudioUnit(
                bytes, product.audioUnitBox,
                {keepMIDIEffects: true, keepAudioEffects: true})
            if (attempt.isFailure()) {
                RuntimeNotifier.info({
                    headline: "Can't Apply Preset",
                    message: attempt.failureReason()
                }).then()
            }
        })
        project.loadScriptDevices()
    }
}
