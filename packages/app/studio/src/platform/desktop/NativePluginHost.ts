import {Arrays, Exec, isDefined, Notifier, Nullable, Observer, RuntimeNotifier, Subscription, tryCatch, UUID} from "@opendaw/lib-std"
import {Platform} from "@opendaw/lib-dom"
import {Box, BoxGraph, Field} from "@opendaw/lib-box"
import {BoxIO, NativeEffectBox, NativeInstrumentBox} from "@opendaw/studio-boxes"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {DeviceHost, Devices, InstrumentFactory, TrackType} from "@opendaw/studio-adapters"
import {Project, WclapParameters} from "@opendaw/studio-core"
import {NativeEnginePort} from "@/platform/desktop/bridge/NativeEnginePort"
import {Shell} from "@/platform/desktop/Shell"
import type {NativeNotice, NativePluginInfo} from "@/platform/desktop/engine/NativePlugins"
import {StudioService} from "@/service/StudioService"

export type NativeStatus = "loading" | "ready" | "failed"

// Native plugins in the engine process: the catalogue, each device's load status and window, its saved state
export namespace NativePluginHost {
    const state: {
        port: Nullable<NativeEnginePort>, service: Nullable<StudioService>, plugins: ReadonlyArray<NativePluginInfo>
        notices: Nullable<WebSocket>, scanning: boolean
    } = {port: null, service: null, plugins: [], notices: null, scanning: false}
    const statuses = new Map<string, NativeStatus>()
    const openWindows = new Set<string>()
    // plugins that return without processing (an unlicensed plugin)
    const inactive = new Set<string>()
    // plugins just added open their window once ready, as in other hosts (some apply their default preset only then)
    const openWhenReady = new Set<string>()

    export const openOnceReady = (uuid: string): void => {openWhenReady.add(uuid)}
    const notifier = new Notifier<void>()
    const catalogue = new Notifier<void>()

    const SaveTimeoutMillis = 2000
    const saving: Array<Exec> = []

    export const attachService = (service: StudioService): void => {
        state.service = service
        service.projectProfileService.addBeforeSave(flush)
        connect()
        watchDialogs()
    }

    // the engine writes every changed plugin state into its box, then answers "saved"
    const flush = (): Promise<void> => {
        if (state.port === null) {return Promise.resolve()}
        const {resolve, promise} = Promise.withResolvers<void>()
        const timeout = setTimeout(resolve, SaveTimeoutMillis)
        saving.push(() => {
            clearTimeout(timeout)
            resolve()
        })
        state.port.send({type: "native-save"})
        return promise
    }

    // the user's own plugin folders, scanned with the system folders
    const FoldersKey = "opendaw:native-plugin-folders"

    export const folders = (): ReadonlyArray<string> => {
        const stored = tryCatch(() => JSON.parse(Platform.storage().getItem(FoldersKey) ?? "[]"))
        return stored.status === "success" && Array.isArray(stored.value) ? stored.value.filter(folder => typeof folder === "string") : []
    }

    export const setFolders = (list: ReadonlyArray<string>): void => {
        Platform.storage().setItem(FoldersKey, JSON.stringify(list))
        rescan(false)
    }

    // scanning runs in the engine process on a thread of its own, the result arrives as a "plugins" notice
    export const rescan = (force: boolean = true): void => {
        state.scanning = true
        catalogue.notify()
        send({type: "scan", folders: folders(), force})
    }

    const send = (request: Record<string, unknown>): void => {
        const socket = state.notices
        if (socket === null) {return}
        const text = JSON.stringify(request)
        if (socket.readyState === WebSocket.OPEN) {socket.send(text)} else {socket.addEventListener("open", () => socket.send(text), {once: true})}
    }

    // plugin windows float above the studio, an open studio dialog must not be covered by them
    const watchDialogs = (): void => {
        const watch = {open: false}
        const update = (): void => {
            const open = document.querySelector("dialog[open]") !== null
            if (open === watch.open) {return}
            watch.open = open
            send({type: "dialogs", open})
        }
        new MutationObserver(update).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ["open"]})
    }

    export const isScanning = (): boolean => state.scanning

    export const attachPort = (port: NativeEnginePort): void => {state.port = port}

    // the notices (plugins, states, windows) need no project, the socket opens with the engine process
    const connect = (): void => {
        if (state.notices !== null) {return}
        const {engine} = Shell.info()
        if (!isDefined(engine)) {return}
        const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/native?token=${engine.token}`)
        socket.binaryType = "arraybuffer"
        socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
            const {data} = event
            if (typeof data === "string") {
                deliverNotices(JSON.parse(data))
            } else {
                storeState(new TextDecoder().decode(new Uint8Array(data, 0, UuidLength)), new Int8Array(data, UuidLength))
            }
        }
        // the engine process went away: its plugins and windows are gone, the restarted one is reached again
        socket.onclose = () => {
            state.notices = null
            statuses.clear()
            inactive.clear()
            openWindows.clear()
            notifier.notify()
            setTimeout(connect, 250)
        }
        state.notices = socket
        rescan(false)
    }

    export const plugins = (): ReadonlyArray<NativePluginInfo> => state.plugins

    export const status = (uuid: string): NativeStatus => statuses.get(uuid) ?? "loading"

    export const isOpen = (uuid: string): boolean => openWindows.has(uuid)

    export const isProcessing = (uuid: string): boolean => !inactive.has(uuid)

    export const toggleWindow = (uuid: string): void => state.port?.send({type: "native-gui", uuid, open: !openWindows.has(uuid)})

    export const subscribe = (observer: Observer<void>): Subscription => notifier.subscribe(observer)

    export const subscribeCatalogue = (observer: Observer<void>): Subscription => catalogue.subscribe(observer)

    const deliverPlugins = (plugins: ReadonlyArray<NativePluginInfo>): void => {
        state.plugins = plugins
        state.scanning = false
        catalogue.notify()
    }

    export const deliverNotices = (notices: ReadonlyArray<NativeNotice>): void => {
        notices.forEach(({uuid, type, value}) => {
            if (type === "status") {
                statuses.set(uuid, value as NativeStatus)
                if (value !== "loading" && openWhenReady.delete(uuid) && value === "ready" && !openWindows.has(uuid)) {
                    state.port?.send({type: "native-gui", uuid, open: true})
                }
            } else if (type === "processing") {
                if (value === "inactive") {inactive.add(uuid)} else {inactive.delete(uuid)}
            } else if (type === "gui") {
                if (value === "open") {openWindows.add(uuid)} else {openWindows.delete(uuid)}
            } else if (type === "params") {
                withHub(uuid, (project, hub) => WclapParameters.reconcileHub(project, hub, JSON.parse(value)))
            } else if (type === "param") {
                const [id, paramValue] = value.split(":")
                withHub(uuid, (project, hub) => WclapParameters.applyHub(project, hub, Number(id) >>> 0, Number(paramValue)))
            } else if (type === "plugins") {
                deliverPlugins(JSON.parse(value))
            } else if (type === "saved") {
                saving.splice(0).forEach(done => done())
            }
        })
        notifier.notify()
    }

    const isNativeBox = (box: Box): box is NativeInstrumentBox | NativeEffectBox =>
        box instanceof NativeInstrumentBox || box instanceof NativeEffectBox

    const withHub = (uuid: string, procedure: (project: Project, hub: Field<Pointers.Parameter>) => void): void =>
        state.service?.optProject.ifSome(project => project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (isNativeBox(box)) {procedure(project, box.parameters)}
        }))

    const UuidLength = 36

    const storeState = (uuid: string, bytes: Int8Array): void => {
        const project = state.service?.optProject
        project?.ifSome(project => project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (!isNativeBox(box) || Arrays.equals(box.state.getValue(), bytes)) {return}
            project.editing.modify(() => box.state.setValue(bytes), false)
        }))
    }

    const factory: InstrumentFactory<NativePluginInfo, NativeInstrumentBox> = {
        defaultName: "Plugin",
        defaultIcon: IconSymbol.Piano,
        briefDescription: "Plugin",
        description: "A plugin installed on this computer",
        manualPage: "",
        trackType: TrackType.Notes,
        create: (boxGraph: BoxGraph<BoxIO.TypeMap>, host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                 name: string, icon: IconSymbol, info?: NativePluginInfo): NativeInstrumentBox =>
            NativeInstrumentBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue(name)
                box.icon.setValue(IconSymbol.toName(icon))
                box.format.setValue(info?.format ?? "")
                box.pluginId.setValue(info?.id ?? "")
                box.pluginName.setValue(info?.name ?? "")
                box.vendor.setValue(info?.vendor ?? "")
                box.host.refer(host)
            })
    }

    export const createInstrument = (service: StudioService, info: NativePluginInfo): void => {
        service.runIfProject(project => project.editing.modify(() => project.api.createInstrument(factory, {name: info.name, attachment: info}))
            .ifSome(({instrumentBox}) => openOnceReady(UUID.toString(instrumentBox.address.uuid))))
    }

    // into the audio effects of the unit the studio is editing, at the end of its chain
    export const createEffect = (service: StudioService, info: NativePluginInfo): void => {service.runIfProject(project => {
        const editing = project.userEditingManager.audioUnit.get()
        if (editing.isEmpty()) {
            RuntimeNotifier.notify({message: "Create an instrument or select an audio-bus first.", icon: "Info"})
            return
        }
        const deviceHost = project.boxAdapters.adapterFor(editing.unwrap().box, Devices.isHost)
        if (!DeviceHost.takesEffect(deviceHost, "audio")) {
            RuntimeNotifier.notify({message: "The selected target does not accept audio effects.", icon: "Info"})
            return
        }
        const field = DeviceHost.chainFieldOf(deviceHost, "audio").unwrap("audio chain")
        project.editing.modify(() => NativeEffectBox.create(project.boxGraph, UUID.generate(), box => {
            box.label.setValue(info.name)
            box.format.setValue(info.format)
            box.pluginId.setValue(info.id)
            box.pluginName.setValue(info.name)
            box.vendor.setValue(info.vendor)
            box.index.setValue(field.pointerHub.incoming().length)
            box.host.refer(field)
        })).ifSome(box => openOnceReady(UUID.toString(box.address.uuid)))
    })}
}
