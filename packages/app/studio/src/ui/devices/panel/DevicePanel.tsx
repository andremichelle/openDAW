import css from "./DevicePanel.sass?inline"
import {
    asDefined,
    isAbsent,
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
import {deferNextFrame, Events, Html, Keyboard, ShortcutManager} from "@opendaw/lib-dom"
import {DevicePanelShortcuts} from "@/ui/shortcuts/DevicePanelShortcuts"
import {DevicePanelDragAndDrop} from "@/ui/devices/DevicePanelDragAndDrop"
import {CompositeCellEditor} from "@/ui/devices/CompositeCellEditor"
import {NoAudioUnitSelectedPlaceholder} from "@/ui/devices/panel/NoAudioUnitSelectedPlaceholder"
import {NoEffectPlaceholder} from "@/ui/devices/panel/NoEffectPlaceholder"
import {DeviceMount} from "@/ui/devices/panel/DeviceMount"
import {Box} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {Project, ProjectProfile} from "@opendaw/studio-core"
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
            }),
            // A composite ENTRY is a host in its own right, but hosts no instrument: its signal comes from the
            // composite. The instrument slot shows the way back out instead (see `updateDom`).
            visitAudioEffectCompositeCellBox: (): Context => ({deviceHost, instrument: new MutableObservableOption()})
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
        // A ONE-SIDED host (a composite entry) hosts only one chain kind; the section it does not host stays empty.
        const midiAdapters = deviceHost.midiEffects.mapOr(chain => chain.adapters(), [])
        appendChildren(midiEffectsContainer, midiAdapters.map((adapter) => mounts.get(adapter.uuid).editor()))
        // A composite entry's back editor is AUDIO, so its slot line reads blue, not the instrument green.
        instrumentContainer.classList.toggle("as-audio", instrument.isEmpty() && !deviceHost.hostsInstrument)
        appendChildren(instrumentContainer, instrument.match({
            // A host that holds no instrument AT ALL is a composite entry: show the way back out, not a void.
            none: () => deviceHost.hostsInstrument
                ? <div/>
                : <CompositeCellEditor lifecycle={chainLifecycle} service={service} host={deviceHost}/>,
            some: (type: AudioUnitInputAdapter) => mounts.get(type.uuid).editor()
        }))
        const audioAdapters = deviceHost.audioEffects.mapOr(chain => chain.adapters(), [])
        appendChildren(audioEffectsContainer, audioAdapters.map((adapter) => mounts.get(adapter.uuid).editor()))
        const hidden = !optEditing.nonEmpty() || midiAdapters.length > 0 || audioAdapters.length > 0
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
        midiEffects: Option<IndexedBoxAdapterCollection<MidiEffectDeviceAdapter, Pointers.MIDIEffectHost>>,
        instrument: ObservableOption<AudioUnitInputAdapter>,
        audioEffects: Option<IndexedBoxAdapterCollection<AudioEffectDeviceAdapter, Pointers.AudioEffectHost>>,
        host: DeviceHost
    }): Terminable => {
        const terminator = new Terminator()
        const instrumentLifecycle = new Terminator()
        // A ONE-SIDED host has no chain of the other kind: nothing to observe, nothing to mount.
        midiEffects.ifSome(chain => terminator.own(chain.catchupAndSubscribe({
            onAdd: (adapter: MidiEffectDeviceAdapter) => {
                mounts.add(DeviceMount.forMidiEffect(service, adapter, host, updateDom.request))
                updateDom.request()
            },
            onRemove: (adapter: MidiEffectDeviceAdapter) => {
                mounts.removeByKey(adapter.uuid).terminate()
                updateDom.request()
            },
            onReorder: (_adapter: MidiEffectDeviceAdapter) => updateDom.request()
        })))
        terminator.ownAll(
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
            })
        )
        audioEffects.ifSome(chain => terminator.own(chain.catchupAndSubscribe({
            onAdd: (adapter: AudioEffectDeviceAdapter) => {
                mounts.add(DeviceMount.forAudioEffect(service, adapter, host, updateDom.request))
                updateDom.request()
            },
            onRemove: (adapter: AudioEffectDeviceAdapter) => {
                mounts.removeByKey(adapter.uuid).terminate()
                updateDom.request()
            },
            onReorder: (_adapter: AudioEffectDeviceAdapter) => updateDom.request()
        })))
        terminator.own({
            terminate: () => {
                mounts.forEach(mount => mount.terminate())
                mounts.clear()
                updateDom.request()
            }
        })
        updateDom.request()
        return terminator
    }

    const updateFrozenState = (): void => {
        const profile = service.projectProfileService.getValue()
        if (profile.isEmpty()) {return}
        const project = profile.unwrap().project
        const optEditing = project.userEditingManager.audioUnit.get()
        if (optEditing.isEmpty()) {return}
        const audioUnitBoxAdapter = project.boxAdapters
            .adapterFor(optEditing.unwrap().box, Devices.isHost).audioUnitBoxAdapter()
        containers.classList.toggle("frozen", project.audioUnitFreeze.isFrozen(audioUnitBoxAdapter))
    }
    const freezeLifecycle = lifecycle.own(new Terminator())
    const chainLifeTime = lifecycle.own(new Terminator())
    lifecycle.own(service.projectProfileService.catchupAndSubscribe((option: Option<ProjectProfile>) => {
            chainLifeTime.terminate()
            freezeLifecycle.terminate()
            option.ifSome(({project}) => {
                freezeLifecycle.own(project.audioUnitFreeze.subscribe(() => updateFrozenState()))
                project.userEditingManager.audioUnit.catchupAndSubscribe((target) => {
                    chainLifeTime.terminate()
                    if (target.isEmpty()) {return}
                    const editingBox = target.unwrap().box
                    const {deviceHost, instrument} = getContext(project, editingBox)
                    chainLifeTime.own(subscribeChain({
                        midiEffects: deviceHost.midiEffects,
                        instrument,
                        audioEffects: deviceHost.audioEffects,
                        host: deviceHost
                    }))
                    updateFrozenState()
                })
            })
        })
    )
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
    // Element-scoped shortcut context: active only while focus is inside
    // the instrument container, so Delete on the focused instrument removes
    // the whole audio unit without competing with global Delete handling.
    const instrumentShortcuts = ShortcutManager.get().createContext(instrumentContainer, "DevicePanel/Instrument")
    lifecycle.ownAll(
        instrumentShortcuts,
        instrumentShortcuts.register(DevicePanelShortcuts["delete-audio-unit"].shortcut, () => {
            const optHost = getCurrentDeviceHost()
            if (optHost.isEmpty()) {return false}
            const audioUnit = optHost.unwrap().audioUnitBoxAdapter()
            if (audioUnit.isOutput) {return false}
            const {editing, api} = service.project
            editing.modify(() => api.deleteAudioUnit(audioUnit.box))
            return true
        }),
        Html.watchResize(element, updateScroller),
        scrollModel.subscribe(() => devices.scrollLeft = scrollModel.position),
        Events.subscribe(element, "wheel", (event: WheelEvent) => scrollModel.moveBy(event.deltaX), {passive: true}),
        installAutoScroll(devices, (deltaX, _deltaY) => scrollModel.position += deltaX, {padding: [0, 32, 0, 0]}),
        DevicePanelDragAndDrop.install(service.project, devices, midiEffectsContainer, instrumentContainer, audioEffectsContainer),
        Events.subscribe(devices, "pointerdown", (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Element && isAbsent(target.closest("[data-drag]"))) {
                service.project.deviceSelection.deselectAll()
            }
        }),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (Keyboard.isDelete(event)) {
                const {deviceSelection, editing} = service.project
                if (deviceSelection.isEmpty()) {return}
                const optHost = getCurrentDeviceHost()
                if (optHost.isEmpty()) {return}
                const host = optHost.unwrap()
                const selected = new Set(deviceSelection.selected().filter(adapter => adapter.type !== "instrument"))
                if (selected.size === 0) {return}
                event.preventDefault()
                const remainingMidi = host.midiEffects
                    .mapOr(chain => chain.adapters().filter(adapter => !selected.has(adapter)), [])
                const remainingAudio = host.audioEffects
                    .mapOr(chain => chain.adapters().filter(adapter => !selected.has(adapter)), [])
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