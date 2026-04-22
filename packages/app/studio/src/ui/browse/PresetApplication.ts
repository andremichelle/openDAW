import {isDefined, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {InstrumentFactories, PresetDecoder} from "@opendaw/studio-adapters"
import {PresetStorage, Project} from "@opendaw/studio-core"

export namespace PresetApplication {
    const loadBytes = (uuid: UUID.String): Promise<ArrayBufferLike> =>
        PresetStorage.load(UUID.parse(uuid))

    export const createNewAudioUnitFromRack = async (project: Project, uuid: UUID.String): Promise<void> => {
        const bytes = await loadBytes(uuid)
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
                                                           deviceKey: InstrumentFactories.Keys): Promise<void> => {
        const bytes = await loadBytes(uuid)
        const factory = InstrumentFactories.Named[deviceKey]
        project.editing.modify(() => {
            const product = project.api.createAnyInstrument(factory)
            const attempt = PresetDecoder.replaceAudioUnit(
                bytes as ArrayBuffer, product.audioUnitBox,
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
