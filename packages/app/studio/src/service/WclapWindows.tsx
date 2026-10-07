import {
    AutomatableParameterFieldAdapter, WclapDeviceBoxAdapter, WclapInstrumentBoxAdapter
} from "@opendaw/studio-adapters"
import {
    asInstanceOf, EmptyExec, isDefined, Notifier, Optional, Procedure, RuntimeNotifier, Subscription, Terminator, UUID
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {ContextMenu, MenuItem, WclapBundles, WclapGuis} from "@opendaw/studio-core"
import {FloatingWindow, FloatingWindowHandle} from "@/ui/components/FloatingWindow.tsx"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {parameterContextItems} from "@/ui/menu/automation.ts"
import {StudioService} from "@/service/StudioService"

export type WclapAdapter = WclapDeviceBoxAdapter | WclapInstrumentBoxAdapter

const DEFAULT_SIZE = {width: 640, height: 480}
const SAVE_DELAY_MS = 250
const MAX_MESSAGE_BYTES = 16 << 20
// separate plugin origin isolates third-party pages from the studio, empty = studio origin (dev only)
const FRAME_ORIGIN: string = import.meta.env.VITE_WCLAP_ORIGIN ?? ""
const FRAME_URL = `${FRAME_ORIGIN}${import.meta.env.BASE_URL}wclap-frame.html`

// `file:///bundle/html/index.html?x` and `/ui/index.html` both name a bundle-root path (query kept)
const pagePath = (uri: string): string =>
    uri.startsWith("file:") ? uri.replace(/^file:\/*/, "/").split("/").slice(2).join("/") : uri.replace(/^\//, "")

type FrameMessage =
    | { type: "wclap-frame-ready" }
    | { type: "wclap-message", bytes: ArrayBuffer }
    | { type: "wclap-contextmenu", x: number, y: number }
    | { type: "wclap-dblclick", x: number, y: number }
    | { type: "wclap-key", kind: "keydown" | "keyup", init: KeyboardEventInit }
    | { type: "wclap-error", message: string }

const isFrameMessage = (data: unknown): data is FrameMessage =>
    typeof data === "object" && data !== null && typeof Object(data).type === "string" && String(Object(data).type).startsWith("wclap-")

// The open plugin windows, one per device, living as long as the device and the project, not the editor
export namespace WclapWindows {
    type Entry = { handle: FloatingWindowHandle, session: Terminator }
    const windows = new Map<string, Entry>()
    const opening = new Set<string>()
    const changes = new Notifier<string>()

    export const isOpen = (uuid: string): boolean => windows.has(uuid)

    export const subscribe = (uuid: string, listener: Procedure<boolean>): Subscription =>
        changes.subscribe(changed => {if (changed === uuid) {listener(windows.has(uuid))}})

    export const close = (uuid: string): void => windows.get(uuid)?.handle.close()

    export const toggle = (service: StudioService, adapter: WclapAdapter, title: string): void => {
        const uuid = UUID.toString(adapter.uuid)
        if (windows.has(uuid)) {
            close(uuid)
            return
        }
        if (opening.has(uuid)) {return}
        opening.add(uuid)
        open(service, adapter, title)
            .catch(error => RuntimeNotifier.notify({message: `Could not open the plugin window: ${error}`, icon: "Warning"}))
            .finally(() => opening.delete(uuid))
    }

    const open = async (service: StudioService, adapter: WclapAdapter, title: string): Promise<void> => {
        const {project, engine} = service
        const {editing, midiLearning} = project
        const uuid = adapter.uuid
        const uuidString = UUID.toString(uuid)
        const gui = await engine.wclapOpenGui(uuid)
        if (gui.uri.length === 0) {
            RuntimeNotifier.notify({message: "The plugin is not ready yet", icon: "Warning"})
            return
        }
        const bundle = await WclapBundles.fetch(adapter.urlField.getValue())
        const page = pagePath(gui.uri)
        const width = gui.width > 0 ? gui.width : DEFAULT_SIZE.width
        const height = gui.height > 0 ? gui.height : DEFAULT_SIZE.height
        const iframe: HTMLIFrameElement = <iframe style={{border: "none", width: `${width}px`, height: `${height}px`}}/>
        const frameOrigin = new URL(FRAME_URL, location.href).origin
        const session = new Terminator()
        const saveTimer: { id: Optional<ReturnType<typeof setTimeout>> } = {id: undefined}
        const scheduleSave = () => {
            if (isDefined(saveTimer.id)) {clearTimeout(saveTimer.id)}
            saveTimer.id = setTimeout(() => engine.wclapSaveState(uuid), SAVE_DELAY_MS)
        }
        const post = (message: object): void => iframe.contentWindow?.postMessage(message, frameOrigin)
        // in-page right-click and double-click are enabled by the plugin's first clap.param-hovered report
        const menuParameter: { parameter: Optional<AutomatableParameterFieldAdapter> } = {parameter: undefined}
        const hoveredParameter = (): Optional<AutomatableParameterFieldAdapter> => {
            const paramId = WclapGuis.hoveredParam(uuidString)
            if (paramId < 0) {return undefined}
            const paramBox = adapter.box.parameters.pointerHub.incoming()
                .map(({box}) => asInstanceOf(box, WclapParameterBox))
                .find(paramBox => (paramBox.clapId.getValue() >>> 0) === paramId)
            if (!isDefined(paramBox)) {return undefined}
            return adapter.parameters.parameters().find(parameter => parameter.address.equals(paramBox.value.address))
        }
        const enterValue = (parameter: AutomatableParameterFieldAdapter, x: number, y: number): void => {
            const flyout = Layers.get(iframe).flyout
            const iframeRect = iframe.getBoundingClientRect()
            const flyoutRect = flyout.getBoundingClientRect()
            const printValue = parameter.getPrintValue()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(text => {
                editing.modify(() => parameter.setPrintValue(text))
                editing.mark()
            }, EmptyExec)
            flyout.appendChild(
                <FloatingTextInput position={{x: iframeRect.left - flyoutRect.left + x, y: iframeRect.top - flyoutRect.top + y}}
                                   value={printValue.value}
                                   unit={printValue.unit}
                                   numeric
                                   resolvers={resolvers}/>
            )
        }
        const onFrameMessage = (message: FrameMessage): void => {
            if (message.type === "wclap-frame-ready") {
                post({type: "wclap-open", uuid: uuidString, page, files: bundle.files})
            } else if (message.type === "wclap-message") {
                if (message.bytes.byteLength > MAX_MESSAGE_BYTES) {return}
                engine.wclapReceive(uuid, message.bytes)
                scheduleSave()
            } else if (message.type === "wclap-contextmenu") {
                menuParameter.parameter = hoveredParameter()
                if (!isDefined(menuParameter.parameter)) {return}
                const rect = iframe.getBoundingClientRect()
                iframe.dispatchEvent(new MouseEvent("contextmenu", {
                    bubbles: true, cancelable: true, clientX: rect.left + message.x, clientY: rect.top + message.y
                }))
            } else if (message.type === "wclap-dblclick") {
                const parameter = hoveredParameter()
                if (isDefined(parameter)) {enterValue(parameter, message.x, message.y)}
            } else if (message.type === "wclap-key") {
                globalThis.dispatchEvent(new KeyboardEvent(message.kind, message.init))
            } else if (message.type === "wclap-error") {
                RuntimeNotifier.notify({message: message.message, icon: "Warning"})
            }
        }
        session.own(WclapGuis.register(uuidString, bytes => post({type: "wclap-message", bytes})))
        session.own(WclapGuis.subscribeHovered(uuidString, paramId => {
            if (paramId >= 0) {post({type: "wclap-pointer-enable"})}
        }))
        session.own(ContextMenu.subscribe(iframe, collector => {
            const parameter = menuParameter.parameter
            if (!isDefined(parameter)) {return}
            const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
            collector.addItems(MenuItem.default({label: parameter.name, selectable: false}),
                ...parameterContextItems(editing, midiLearning, tracks, parameter))
        }))
        session.own(Events.subscribe(globalThis, "message", (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow || event.origin !== frameOrigin || !isFrameMessage(event.data)) {return}
            onFrameMessage(event.data)
        }))
        session.ownAll(
            adapter.urlField.subscribe(() => close(uuidString)),
            adapter.clapIdField.subscribe(() => close(uuidString)),
            adapter.box.subscribeDeletion(() => close(uuidString)),
            service.projectProfileService.subscribe(() => close(uuidString)),
            {
                terminate: () => {
                    if (isDefined(saveTimer.id)) {clearTimeout(saveTimer.id)}
                    engine.wclapSaveState(uuid)
                    engine.wclapCloseGui(uuid)
                    windows.delete(uuidString)
                    changes.notify(uuidString)
                }
            }
        )
        iframe.src = FRAME_URL
        const handle = FloatingWindow({
            title, icon: IconSymbol.WebClap, width, height, onClose: () => session.terminate()
        }, iframe)
        windows.set(uuidString, {handle, session})
        changes.notify(uuidString)
    }
}
