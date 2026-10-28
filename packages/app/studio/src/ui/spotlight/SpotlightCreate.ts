import {asInstanceOf, DefaultObservableValue, Errors, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Box, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitType} from "@opendaw/studio-enums"
import {
    ApparatDeviceBox, AudioUnitBox, SpielwerkDeviceBox, WclapDeviceBox, WclapInstrumentBox, WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import {
    DeviceHost, Devices, InstrumentBox, InstrumentFactories, InstrumentFactory, ScriptCompiler, WclapPluginInfo
} from "@opendaw/studio-adapters"
import {EffectFactories, EffectFactory, PresetEntry, Project, WclapStates, WclapStorage} from "@opendaw/studio-core"
import type {StudioService} from "@/service/StudioService"
import {CommunityAPI} from "@/opendaw-api/CommunityAPI"
import {CommunityScript, CommunityScriptTarget} from "@/opendaw-api/CommunityIndex"
import {WclapCatalog} from "@/opendaw-api/WclapCatalog"
import {WclapDescriber} from "@/service/WclapDescriber"
import {WclapNames} from "@/service/WclapNames"
import {PresetApplication} from "@/ui/browse/PresetApplication"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"

export namespace SpotlightCreate {
    export type Wclap = {
        readonly id: string, readonly name: string, readonly info: WclapPluginInfo
        readonly local: boolean, readonly license: string, readonly size: number
    }

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
    export const anchorAfterEditing = (project: Project): Option<UUID.Bytes> => editingHost(project)
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

    export type ScriptTarget = Exclude<CommunityScriptTarget, "project">

    export const ScriptHosts = {
        apparat: InstrumentFactories.Apparat,
        werkstatt: EffectFactories.AudioNamed.Werkstatt,
        spielwerk: EffectFactories.MidiNamed.Spielwerk
    } as const

    // creates the host device of a dropped script, None when it cannot go there
    export type ScriptPlacement = (project: Project) => Option<Box>

    export const script = (service: StudioService, script: CommunityScript,
                           place: Option<ScriptPlacement> = Option.None): void =>
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
                const box = place.match({
                    none: () => createScriptDevice(project, target),
                    some: placement => placement(project)
                        .flatMap(box => isScriptDevice(box) ? Option.wrap(box) : Option.None)
                })
                // no header yet: an editor mounting before the compile below loads nothing
                box.ifSome(box => box.code.setValue(userCode))
                return box
            }).flatMap(box => box)
            await created.match({
                none: async () => {
                    if (place.isEmpty()) {RuntimeNotifier.notify({message: "Select a track that takes this effect first.", icon: "Info"})}
                },
                some: box => compiler.compile(service.audioContext, project.editing, box, userCode, true)
            })
        })

    export const scriptConfigs = {apparat: "Apparat", werkstatt: "Werkstatt", spielwerk: "Spielwerk"} as const

    const isScriptDevice = (box: Box): box is ScriptCompiler.ScriptDeviceBox =>
        box instanceof ApparatDeviceBox || box instanceof WerkstattDeviceBox || box instanceof SpielwerkDeviceBox

    const createScriptDevice = (project: Project, target: ScriptTarget)
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

    export const wclaps = async (): Promise<ReadonlyArray<Wclap>> => {
        const [published, stored] = await Promise.all([
            WclapCatalog.get().all().catch(() => []),
            WclapDescriber.stored().catch(() => [])
        ])
        const cloud = published.flatMap(({uuid, name, plugins, license, size}) => {
            const shortNames = WclapNames.distinct(plugins.map(info => info.name))
            return plugins.map((info, index) => ({
                id: uuid, name: plugins.length > 1 ? shortNames[index] : name, info, local: false, license, size
            }))
        })
        const cloudIds = new Set(published.map(({uuid}) => uuid))
        const local = Array.from(new Set(stored.map(({url}) => url)))
            .filter(url => !cloudIds.has(WclapStorage.idOf(url)))
            .flatMap(url => {
                const bundle = stored.filter(plugin => plugin.url === url)
                const shortNames = WclapNames.distinct(bundle.map(({info}) => info.name))
                return bundle.map(({info}, index) => ({
                    id: WclapStorage.idOf(url), name: shortNames[index], info, local: true, license: "", size: 0
                }))
            })
        return [...cloud, ...local]
    }

    export const storeWclap = async ({id, name}: Wclap): Promise<string> => {
        if (await WclapStorage.exists(id)) {return WclapStorage.urlOf(id)}
        const progress = new DefaultObservableValue(0.0)
        const controller = new AbortController()
        const dialog = RuntimeNotifier.progress({
            headline: `Downloading ${name}`, progress, cancel: () => controller.abort(Errors.AbortError)
        })
        const result = await Promises.tryCatch(WclapCatalog.get().load(id, value => progress.setValue(value), controller.signal)
            .then(archive => WclapStorage.store(archive)))
        dialog.terminate()
        if (result.status === "rejected") {throw result.error}
        if (result.value !== WclapStorage.urlOf(id)) {throw new Error("the download does not match its id")}
        return result.value
    }

    export const wclap = (service: StudioService, wclap: Wclap): void =>
        withProject(service, async project => {
            const url = await Promises.tryCatch(storeWclap(wclap))
            if (url.status === "rejected" && Errors.isAbort(url.error)) {return}
            if (url.status === "rejected") {
                console.warn(url.error)
                RuntimeNotifier.notify({message: `Could not download ${wclap.name}.`, icon: "Warning"})
                return
            }
            const {clapId, name} = wclap.info
            project.editing.modify(() => {
                const box: Option<WclapDeviceBox | WclapInstrumentBox> = WclapDescriber.kindOf(wclap.info) === "instrument"
                    ? Option.wrap(asInstanceOf(createInstrument(project, InstrumentFactories.Wclap), WclapInstrumentBox))
                    : effectField(project, "audio").map(field => asInstanceOf(
                        EffectFactories.AudioNamed.Wclap.create(project, field, field.pointerHub.incoming().length), WclapDeviceBox))
                box.ifSome(box => {
                    box.url.setValue(url.value)
                    box.clapId.setValue(clapId)
                    WclapStates.name(project, box, undefined, name)
                })
            })
        })
}