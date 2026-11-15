import css from "./DemoModePage.sass?inline"
import {Arrays, Exec, Lifecycle, Predicates, RuntimeNotifier, Terminator, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html, Key, Shortcut, ShortcutManager} from "@opendaw/lib-dom"
import {
    AudioEffectDeviceAdapter, AudioUnitBoxAdapter, DeviceBoxAdapter, MidiEffectDeviceAdapter
} from "@opendaw/studio-adapters"
import {Project, ProjectProfile} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DeviceMount} from "@/ui/devices/panel/DeviceMount"
import {DemoModeSelection} from "@/ui/pages/DemoModeSelection"
import {ProjectBrowser} from "@/project/ProjectBrowser"
import {Dialogs} from "@/ui/components/dialogs"

const className = Html.adoptStyleSheet(css, "DemoModePage")

type DemoDevice = {
    readonly adapter: DeviceBoxAdapter
    readonly host: AudioUnitBoxAdapter
    readonly kind: "midi" | "source" | "audio"
    readonly mount: (service: StudioService, invalidate: Exec) => DeviceMount
}

const collectDevices = (project: Project): ReadonlyArray<DemoDevice> =>
    project.rootBoxAdapter.audioUnits.adapters().flatMap(host => {
        const midi = host.midiEffects.mapOr(chain => chain.adapters(), Arrays.empty<MidiEffectDeviceAdapter>())
            .map((adapter): DemoDevice => ({
                adapter, host, kind: "midi",
                mount: (service, invalidate) => DeviceMount.forMidiEffect(service, adapter, host, invalidate)
            }))
        const source = host.inputAdapter.mapOr(adapter => [{
            adapter, host, kind: "source",
            mount: (service, invalidate) => DeviceMount.forInstrument(service, adapter, host, invalidate)
        } satisfies DemoDevice], Arrays.empty<DemoDevice>())
        const audio = host.audioEffects.mapOr(chain => chain.adapters(), Arrays.empty<AudioEffectDeviceAdapter>())
            .map((adapter): DemoDevice => ({
                adapter, host, kind: "audio",
                mount: (service, invalidate) => DeviceMount.forAudioEffect(service, adapter, host, invalidate)
            }))
        return [...midi, ...source, ...audio]
    })

export const DemoModePage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const picker: HTMLElement = <div className="picker"/>
    const stage: HTMLElement = <div className="stage"/>
    const element: HTMLElement = <div className={className}>{picker}{stage}</div>
    const projectLifecycle = lifecycle.own(new Terminator())
    const shortcuts = ShortcutManager.get().createContext(Predicates.alwaysTrue, "DemoModePage")
    lifecycle.ownAll(
        shortcuts,
        shortcuts.register(Shortcut.of(Key.KeyH), () => {picker.classList.toggle("hidden")}),
        shortcuts.register(Shortcut.of(Key.KeyC), () => {element.classList.toggle("cursor-hidden")}),
        service.projectProfileService.catchupAndSubscribe(optProfile => {
            projectLifecycle.terminate()
            Html.empty(picker)
            Html.empty(stage)
            optProfile.match({
                none: () => stage.appendChild(
                    <div className="browser">
                        <ProjectBrowser service={service}
                                        lifecycle={projectLifecycle}
                                        select={async ([uuid, meta]) => {
                                            const handler = Dialogs.processMonolog("Loading...")
                                            const {status, error} = await Promises.tryCatch(
                                                service.projectProfileService.load(uuid, meta))
                                            handler.close()
                                            if (status === "rejected") {
                                                console.warn(error)
                                                RuntimeNotifier.notify({message: "Could not load project.", icon: "Warning"})
                                            }
                                        }}/>
                    </div>
                ),
                some: profile => populate(projectLifecycle, service, profile, picker, stage)
            })
        })
    )
    return element
}

const populate = (lifecycle: Lifecycle, service: StudioService, profile: ProjectProfile,
                  picker: HTMLElement, stage: HTMLElement): void => {
    const stageLifecycle = lifecycle.own(new Terminator())
    const pickerLifecycle = lifecycle.own(new Terminator())
    const devices = collectDevices(profile.project)
    let selection: ReadonlyArray<UUID.Bytes> = DemoModeSelection.load(profile.uuid)
        .filter(uuid => devices.some(({adapter}) => UUID.equals(adapter.uuid, uuid)))
    const isSelected = (uuid: UUID.Bytes): boolean => selection.some(selected => UUID.equals(selected, uuid))
    let rendering = false
    const renderStage = (): void => {
        rendering = true
        stageLifecycle.terminate()
        Html.empty(stage)
        selection.forEach(uuid => devices
            .filter(({adapter}) => UUID.equals(adapter.uuid, uuid))
            .forEach(device => {
                const mount = stageLifecycle.own(device.mount(service, invalidate))
                stage.appendChild(<div className={device.kind}>{mount.editor()}</div>)
            }))
        rendering = false
    }
    const stageUpdate = lifecycle.own(deferNextFrame(renderStage))
    const invalidate = (): void => {if (!rendering) {stageUpdate.request()}}
    const toggle = (uuid: UUID.Bytes): void => {
        selection = isSelected(uuid)
            ? selection.filter(selected => !UUID.equals(selected, uuid))
            : [...selection, uuid]
        DemoModeSelection.save(profile.uuid, selection)
        renderPicker()
        renderStage()
    }
    const renderPicker = (): void => {
        pickerLifecycle.terminate()
        Html.empty(picker)
        picker.appendChild(<h5>Devices <span>H hides this list, C hides the cursor</span></h5>)
        const list: HTMLElement = <div className="list"/>
        profile.project.rootBoxAdapter.audioUnits.adapters().forEach(host => {
            const entries = devices.filter(device => device.host === host)
            if (entries.length === 0) {return}
            list.appendChild(<h6>{host.label}</h6>)
            entries.forEach(({adapter, kind}) => {
                const button: HTMLElement = (
                    <button className={Html.buildClassList(kind, isSelected(adapter.uuid) && "selected")}>
                        {adapter.labelField.getValue()}
                    </button>
                )
                pickerLifecycle.own(Events.subscribe(button, "click", () => toggle(adapter.uuid)))
                list.appendChild(button)
            })
        })
        picker.appendChild(list)
    }
    renderPicker()
    renderStage()
}
