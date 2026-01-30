import css from "./DevicePanel.sass?inline"
import {
    asDefined,
    Lifecycle,
    MutableObservableOption,
    ObservableOption,
    Option,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {appendChildren, createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {AudioUnitBox, BoxVisitor, PlayfieldSampleBox} from "@opendaw/studio-boxes"
import {
    AudioEffectDeviceAdapter,
    AudioUnitInputAdapter,
    DeviceHost,
    Devices,
    IndexedBoxAdapterCollection,
    MidiEffectDeviceAdapter,
    PlayfieldSampleBoxAdapter
} from "@opendaw/studio-adapters"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"
import {Orientation, Scroller} from "@/ui/components/Scroller"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {ChannelStrip} from "@/ui/mixer/ChannelStrip"
import {installAutoScroll} from "@/ui/AutoScroll"
import {deferNextFrame, Events, Html, Keyboard} from "@opendaw/lib-dom"
import {DevicePanelDragAndDrop} from "@/ui/devices/DevicePanelDragAndDrop"
import {NoAudioUnitSelectedPlaceholder} from "@/ui/devices/panel/NoAudioUnitSelectedPlaceholder"
import {NoEffectPlaceholder} from "@/ui/devices/panel/NoEffectPlaceholder"
import {DeviceMount} from "@/ui/devices/panel/DeviceMount"
import {Box} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {ClipboardManager, DevicesClipboard, Project, ProjectProfile} from "@opendaw/studio-core"
import {ShadertoyPreview} from "@/ui/devices/panel/ShadertoyPreview"

const className = Html.adoptStyleSheet(css, "DevicePanel")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type Context = { deviceHost: DeviceHost, instrument: ObservableOption<AudioUnitInputAdapter> }

export const DevicePanel = ({lifecycle, service}: Construct) => {
    const midiEffectsContainer: HTMLElement = <div className="midi-container"/>
    const instrumentContainer: HTMLElement = <div className="source-container"/>
    const audioEffectsContainer: HTMLElement = <div className="audio-container"/>
    const channelStripContainer: HTMLElement = <div className="channel-strip-container"/>
    const noAudioUnitSelectedPlaceholder: HTMLElement = (
        <NoAudioUnitSelectedPlaceholder lifecycle={lifecycle} service={service}/>
    )
    const noEffectPlaceholder: HTMLElement = (
        <NoEffectPlaceholder service={service}/>
    )
    const containers: HTMLElement = (
        <div className="containers">
            {midiEffectsContainer}
            {instrumentContainer}
            {audioEffectsContainer}
        </div>
    )
    const devices: HTMLElement = (
        <div className="editors">
            {containers}
            {noAudioUnitSelectedPlaceholder}
            {noEffectPlaceholder}
        </div>
    )
    const scrollModel = new ScrollModel()
    const updateScroller = (): void => {
        scrollModel.visibleSize = devices.clientWidth
        scrollModel.contentSize = containers.clientWidth
    }

    const getContext = (project: Project, box: Box): Context => {
        const deviceHost = project.boxAdapters.adapterFor(box, Devices.isHost)
        return asDefined(box.accept<BoxVisitor<Context>>({
            visitAudioUnitBox: (_box: AudioUnitBox): Context => ({
                deviceHost,
                instrument: deviceHost.audioUnitBoxAdapter().input.adapter()
            }),
            visitPlayfieldSampleBox: (box: PlayfieldSampleBox): Context => ({
                deviceHost,
                instrument: new MutableObservableOption(project.boxAdapters.adapterFor(box, PlayfieldSampleBoxAdapter))
            })
        }))
    }

    const chainLifecycle = lifecycle.own(new Terminator())
    const mounts = UUID.newSet<DeviceMount>(({uuid}) => uuid)
    const updateDom = lifecycle.own(deferNextFrame(() => {
        Html.empty(midiEffectsContainer)
        Html.empty(instrumentContainer)
        Html.empty(audioEffectsContainer)
        Html.empty(channelStripContainer)
        chainLifecycle.terminate()
        const profile = service.projectProfileService.getValue()
        if (profile.isEmpty()) {return}
        const {project} = profile.unwrap()
        const optEditing = project.userEditingManager.audioUnit.get()
        noAudioUnitSelectedPlaceholder.classList.toggle("hidden", optEditing.nonEmpty())
        noEffectPlaceholder.classList.toggle("hidden", optEditing.isEmpty())
        if (optEditing.isEmpty()) {return}
        const {deviceHost, instrument} = getContext(project, optEditing.unwrap().box)
        if (instrument.nonEmpty()) {
            const input = instrument.unwrap()
            if (input.accepts === "midi") {
                appendChildren(midiEffectsContainer, (
                    <div style={{margin: "1.125rem 0 0 0"}}>
                        <DeviceMidiMeter lifecycle={chainLifecycle}
                                         receiver={project.liveStreamReceiver}
                                         address={deviceHost.audioUnitBoxAdapter().address}/>
                    </div>
                ))
            }
        }
        const midiEffects = deviceHost.midiEffects
        appendChildren(midiEffectsContainer, midiEffects.adapters().map((adapter) => mounts.get(adapter.uuid).editor()))
        appendChildren(instrumentContainer, instrument.match({
            none: () => <div/>,
            some: (type: AudioUnitInputAdapter) => mounts.get(type.uuid).editor()
        }))
        const audioEffects = deviceHost.audioEffects
        appendChildren(audioEffectsContainer, audioEffects.adapters().map((adapter) => mounts.get(adapter.uuid).editor()))
        const hidden = !optEditing.nonEmpty() || !(audioEffects.isEmpty() && midiEffects.isEmpty())
        noEffectPlaceholder.classList.toggle("hidden", hidden)
        appendChildren(channelStripContainer, (
            <ChannelStrip lifecycle={chainLifecycle}
                          service={service}
                          adapter={deviceHost.audioUnitBoxAdapter()}
                          compact={true}/>
        ))
        updateScroller()
    }))

    const subscribeChain = ({midiEffects, instrument, audioEffects, host}: {
        midiEffects: IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>,
        instrument: ObservableOption<AudioUnitInputAdapter>,
        audioEffects: IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>,
        host: DeviceHost
    }): Terminable => {
        const terminator = new Terminator()
        const instrumentLifecycle = new Terminator()
        terminator.ownAll(
            midiEffects.catchupAndSubscribe({
                onAdd: (adapter: MidiEffectDeviceAdapter) => {
                    mounts.add(DeviceMount.forMidiEffect(service, adapter, host, updateDom.request))
                    updateDom.request()
                },
                onRemove: (adapter: MidiEffectDeviceAdapter) => {
                    mounts.removeByKey(adapter.uuid).terminate()
                    updateDom.request()
                },
                onReorder: (_adapter: MidiEffectDeviceAdapter) => updateDom.request()
            }),
            instrument.catchupAndSubscribe(owner => {
                instrumentLifecycle.terminate()
                owner.ifSome(adapter => {
                    mounts.add(DeviceMount.forInstrument(service, adapter, host, updateDom.request))
                    instrumentLifecycle.own({
                        terminate: () => {
                            mounts.removeByKey(adapter.uuid).terminate()
                            updateDom.request()
                        }
                    })
                })
                updateDom.request()
            }),
            audioEffects.catchupAndSubscribe({
                onAdd: (adapter: AudioEffectDeviceAdapter) => {
                    mounts.add(DeviceMount.forAudioEffect(service, adapter, host, updateDom.request))
                    updateDom.request()
                },
                onRemove: (adapter: AudioEffectDeviceAdapter) => {
                    mounts.removeByKey(adapter.uuid).terminate()
                    updateDom.request()
                },
                onReorder: (_adapter: AudioEffectDeviceAdapter) => updateDom.request()
            }),
            {
                terminate: () => {
                    mounts.forEach(mount => mount.terminate())
                    mounts.clear()
                    updateDom.request()
                }
            }
        )
        updateDom.request()
        return terminator
    }

    const chainLifeTime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe((option: Option<ProjectProfile>) => {
        chainLifeTime.terminate()
        option.ifSome(({project: {userEditingManager}}) =>
            userEditingManager.audioUnit.catchupAndSubscribe((target) => {
                chainLifeTime.terminate()
                if (target.isEmpty()) {return}
                const editingBox = target.unwrap().box
                const {deviceHost, instrument} = getContext(service.project, editingBox)
                chainLifeTime.own(subscribeChain({
                    midiEffects: deviceHost.midiEffects,
                    instrument,
                    audioEffects: deviceHost.audioEffects,
                    host: deviceHost
                }))
            }))
    }))
    const element: HTMLElement = (
        <div className={className}>
            <div className="devices">
                {devices}
                <Scroller lifecycle={lifecycle} model={scrollModel} floating={true}
                          orientation={Orientation.horizontal}/>
            </div>
            {channelStripContainer}
            <ShadertoyPreview lifecycle={lifecycle} service={service}/>
        </div>
    )
    updateDom.request()
    const getCurrentDeviceHost = (): Option<DeviceHost> => {
        const profile = service.projectProfileService.getValue()
        if (profile.isEmpty()) {return Option.None}
        const {project} = profile.unwrap()
        const optEditing = project.userEditingManager.audioUnit.get()
        if (optEditing.isEmpty()) {return Option.None}
        return Option.wrap(project.boxAdapters.adapterFor(optEditing.unwrap().box, Devices.isHost))
    }
    lifecycle.ownAll(
        Html.watchResize(element, updateScroller),
        scrollModel.subscribe(() => devices.scrollLeft = scrollModel.position),
        Events.subscribe(element, "wheel", (event: WheelEvent) => scrollModel.moveBy(event.deltaX), {passive: true}),
        installAutoScroll(devices, (deltaX, _deltaY) => scrollModel.position += deltaX, {padding: [0, 32, 0, 0]}),
        DevicePanelDragAndDrop.install(service.project, devices, midiEffectsContainer, instrumentContainer, audioEffectsContainer),
        ClipboardManager.install(devices, DevicesClipboard.createHandler({
            getEnabled: () => getCurrentDeviceHost().nonEmpty(),
            editing: service.project.editing,
            selection: service.project.deviceSelection,
            boxGraph: service.project.boxGraph,
            boxAdapters: service.project.boxAdapters,
            getMidiEffectsField: () => getCurrentDeviceHost().map(host => host.audioUnitBoxAdapter().midiEffectsField),
            getAudioEffectsField: () => getCurrentDeviceHost().map(host => host.audioUnitBoxAdapter().audioEffectsField)
        })),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (Keyboard.isDelete(event)) {
                const {deviceSelection, editing} = service.project
                if (deviceSelection.isEmpty()) {return}
                const optHost = getCurrentDeviceHost()
                if (optHost.isEmpty()) {return}
                const host = optHost.unwrap().audioUnitBoxAdapter()
                const selected = new Set(deviceSelection.selected().filter(adapter => adapter.type !== "instrument"))
                if (selected.size === 0) {return}
                event.preventDefault()
                const remainingMidi = host.midiEffects.adapters().filter(adapter => !selected.has(adapter))
                const remainingAudio = host.audioEffects.adapters().filter(adapter => !selected.has(adapter))
                editing.modify(() => {
                    selected.forEach(adapter => adapter.box.delete())
                    remainingMidi.forEach((adapter, index) => adapter.indexField.setValue(index))
                    remainingAudio.forEach((adapter, index) => adapter.indexField.setValue(index))
                })
            }
        })
    )
    return element
}