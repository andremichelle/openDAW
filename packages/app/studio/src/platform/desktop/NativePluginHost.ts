import {Arrays, Exec, isDefined, Notifier, Nullable, Observer, Subscription, UUID} from "@opendaw/lib-std"
import {BoxGraph, Field} from "@opendaw/lib-box"
import {BoxIO, NativeInstrumentBox} from "@opendaw/studio-boxes"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {InstrumentFactory, TrackType} from "@opendaw/studio-adapters"
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
        notices: Nullable<WebSocket>
    } = {port: null, service: null, plugins: [], notices: null}
    const statuses = new Map<string, NativeStatus>()
    const openWindows = new Set<string>()
    const notifier = new Notifier<void>()
    const catalogue = new Notifier<void>()

    const SaveTimeoutMillis = 2000
    const saving: Array<Exec> = []

    export const attachService = (service: StudioService): void => {
        state.service = service
        service.projectProfileService.addBeforeSave(flush)
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

    export const attachPort = (port: NativeEnginePort): void => {
        state.port = port
        port.send({type: "native-scan"})
        if (state.notices === null) {
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
            socket.onclose = () => state.notices = null
            state.notices = socket
        }
    }

    export const rescan = (): void => state.port?.send({type: "native-scan"})

    export const plugins = (): ReadonlyArray<NativePluginInfo> => state.plugins

    export const status = (uuid: string): NativeStatus => statuses.get(uuid) ?? "loading"

    export const isOpen = (uuid: string): boolean => openWindows.has(uuid)

    export const toggleWindow = (uuid: string): void => state.port?.send({type: "native-gui", uuid, open: !openWindows.has(uuid)})

    export const subscribe = (observer: Observer<void>): Subscription => notifier.subscribe(observer)

    export const subscribeCatalogue = (observer: Observer<void>): Subscription => catalogue.subscribe(observer)

    export const deliverPlugins = (plugins: ReadonlyArray<NativePluginInfo>): void => {
        state.plugins = plugins
        catalogue.notify()
    }

    export const deliverNotices = (notices: ReadonlyArray<NativeNotice>): void => {
        notices.forEach(({uuid, type, value}) => {
            if (type === "status") {
                statuses.set(uuid, value as NativeStatus)
            } else if (type === "gui") {
                if (value === "open") {openWindows.add(uuid)} else {openWindows.delete(uuid)}
            } else if (type === "params") {
                withHub(uuid, (project, hub) => WclapParameters.reconcileHub(project, hub, JSON.parse(value)))
            } else if (type === "param") {
                const [id, paramValue] = value.split(":")
                withHub(uuid, (project, hub) => WclapParameters.applyHub(project, hub, Number(id) >>> 0, Number(paramValue)))
            } else if (type === "saved") {
                saving.splice(0).forEach(done => done())
            }
        })
        notifier.notify()
    }

    const withHub = (uuid: string, procedure: (project: Project, hub: Field<Pointers.Parameter>) => void): void =>
        state.service?.optProject.ifSome(project => project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (box instanceof NativeInstrumentBox) {procedure(project, box.parameters)}
        }))

    const UuidLength = 36

    const storeState = (uuid: string, bytes: Int8Array): void => {
        const project = state.service?.optProject
        project?.ifSome(project => project.boxGraph.findBox(UUID.parse(uuid)).ifSome(box => {
            if (!(box instanceof NativeInstrumentBox) || Arrays.equals(box.state.getValue(), bytes)) {return}
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
        service.runIfProject(project => project.editing.modify(() => project.api.createInstrument(factory, {name: info.name, attachment: info})))
    }
}
