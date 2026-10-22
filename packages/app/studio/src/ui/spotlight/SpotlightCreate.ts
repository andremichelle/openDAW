import {asInstanceOf, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {IndexedBox} from "@opendaw/lib-box"
import {AudioUnitType} from "@opendaw/studio-enums"
import {ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {DeviceHost, Devices, InstrumentBox, InstrumentFactories, InstrumentFactory, ScriptCompiler} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, PresetEntry, Project} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript} from "@/opendaw-api/CommunityIndex"
import {PresetApplication} from "@/ui/browse/PresetApplication"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"

export namespace SpotlightCreate {
    // without a project a new one is started first
    const withProject = (service: StudioService, action: (project: Project) => Promise<void>): void => {
        const run = () => service.hasProfile ? action(service.project) : Promise.resolve()
        const start = service.hasProfile ? Promise.resolve() : service.newProject()
        start.then(run).catch((reason: unknown) => {
            console.warn(reason)
            RuntimeNotifier.notify({message: "Could not create it.", icon: "Warning"})
        })
    }

    const editingHost = (project: Project): Option<DeviceHost> => project.userEditingManager.audioUnit.get()
        .map(vertex => project.boxAdapters.adapterFor(vertex.box, Devices.isHost))

    // the unit after the edit-mode instrument, a new unit is placed before it
    const anchorAfterEditing = (project: Project): Option<UUID.Bytes> => editingHost(project)
        .flatMap(host => {
            const unit = host.audioUnitBoxAdapter().box
            if (unit.type.getValue() !== AudioUnitType.Instrument) {return Option.None}
            const units = IndexedBox.collectIndexedBoxes(project.rootBox.audioUnits, AudioUnitBox)
            return Option.wrap(units.at(unit.index.getValue() + 1)).map(next => next.address.uuid)
        })

    const createInstrument = (project: Project, factory: InstrumentFactory): InstrumentBox => {
        const anchor = anchorAfterEditing(project)
        const {audioUnitBox, instrumentBox} = project.api.createAnyInstrument(factory)
        project.api.placeAudioUnitBefore(audioUnitBox, anchor)
        return instrumentBox
    }

    const effectField = (project: Project, accepts: "audio" | "midi") =>
        editingHost(project).flatMap(host => DeviceHost.takesEffect(host, accepts)
            ? DeviceHost.chainFieldOf(host, accepts) : Option.None)

    export const instrument = (service: StudioService, factory: InstrumentFactory): void =>
        withProject(service, async project => {project.editing.modify(() => createInstrument(project, factory))})

    export const effect = (service: StudioService, factory: EffectFactory): void =>
        withProject(service, async project => effectField(project, factory.type).ifSome(field =>
            project.editing.modify(() => factory.create(project, field, field.pointerHub.incoming().length))))

    export const preset = (service: StudioService, entry: PresetEntry): void =>
        withProject(service, async project => {
            switch (entry.category) {
                case "instrument":
                    return PresetApplication.createNewAudioUnitFromInstrument(
                        project, entry.uuid, entry.device, entry.source, anchorAfterEditing(project))
                case "audio-unit":
                    return PresetApplication.createNewAudioUnitFromRack(
                        project, entry.uuid, entry.source, anchorAfterEditing(project))
                default:
                    return service.presets.activatePreset(entry)
            }
        })

    export const script = (service: StudioService, script: CommunityScript): void =>
        withProject(service, async project => {
            const source = await Promises.tryCatch(CommunityAPI.get().loadSource(script))
            if (source.status === "rejected") {
                console.warn(source.error)
                RuntimeNotifier.notify({message: `Could not load the script '${script.name}'.`, icon: "Warning"})
                return
            }
            const {target} = script
            if (target === "project") {return}
            const config = ScriptCompilers[scriptConfigs[target]]
            const compiler = ScriptCompiler.create(config)
            const userCode = compiler.stripHeader(source.value)
            const created: Option<ScriptCompiler.ScriptDeviceBox> = project.editing.modify(() => {
                const box = createScriptDevice(project, target)
                // no header yet: an editor mounting before the compile below loads nothing
                box.ifSome(box => box.code.setValue(userCode))
                return box
            }).flatMap(box => box)
            await created.match({
                none: () => Promise.resolve(),
                some: box => compiler.compile(service.audioContext, project.editing, box, userCode, true)
            })
        })

    const scriptConfigs = {apparat: "Apparat", werkstatt: "Werkstatt", spielwerk: "Spielwerk"} as const

    const createScriptDevice = (project: Project, target: "apparat" | "werkstatt" | "spielwerk")
        : Option<ScriptCompiler.ScriptDeviceBox> => {
        switch (target) {
            case "apparat":
                return Option.wrap(asInstanceOf(createInstrument(project, InstrumentFactories.Apparat), ApparatDeviceBox))
            case "werkstatt":
                return effectField(project, "audio").map(field => asInstanceOf(
                    EffectFactories.AudioNamed.Werkstatt.create(project, field, field.pointerHub.incoming().length), WerkstattDeviceBox))
            case "spielwerk":
                return effectField(project, "midi").map(field => asInstanceOf(
                    EffectFactories.MidiNamed.Spielwerk.create(project, field, field.pointerHub.incoming().length), SpielwerkDeviceBox))
        }
    }
}
