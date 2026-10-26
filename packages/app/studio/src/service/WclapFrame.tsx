import {AutomatableParameterFieldAdapter, Sample, WclapBundle} from "@opendaw/studio-adapters"
import {
    asInstanceOf, EmptyExec, Exec, isDefined, Option, Optional, RuntimeNotifier, Subscription, Terminable, Terminator, UUID,
    VitalSigns
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ContextMenu, MenuItem, WclapGuis} from "@opendaw/studio-core"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {parameterContextItems} from "@/ui/menu/automation.ts"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {StudioService} from "@/service/StudioService"
import type {WclapAdapter} from "@/service/WclapWindows"

const SAVE_DELAY_MS = 250
const MAX_MESSAGE_BYTES = 16 << 20
// separate plugin origin isolates third-party pages from the studio, empty = studio origin (dev only)
const FRAME_ORIGIN: string = import.meta.env.VITE_WCLAP_ORIGIN ?? ""
const FRAME_URL = `${FRAME_ORIGIN}${import.meta.env.BASE_URL}wclap-frame.html`

// `file:///bundle/html/index.html?x` and `/ui/index.html` both name a bundle-root path (query kept)
const pagePath = (uri: string): string =>
    uri.startsWith("file:") ? uri.replace(/^file:\/*/, "/").split("/").slice(2).join("/") : uri.replace(/^\//, "")

type FrameMessage =
    | { type: "wclap-message", bytes: ArrayBuffer }
    | { type: "wclap-contextmenu", x: number, y: number }
    | { type: "wclap-dblclick", x: number, y: number }
    | { type: "wclap-key", kind: "keydown" | "keyup", init: KeyboardEventInit }
    | { type: "wclap-error", message: string }
    | { type: "wclap-wheel", deltaX: number, deltaY: number, deltaMode: number }

const isFrameMessage = (data: unknown): data is FrameMessage =>
    typeof data === "object" && data !== null && typeof Object(data).type === "string" && String(Object(data).type).startsWith("wclap-")

const isFrameReady = (data: unknown): boolean =>
    typeof data === "object" && data !== null && Object(data).type === "wclap-frame-ready"

export type WclapFrameConfig = {
    service: StudioService
    adapter: WclapAdapter
    bundle: WclapBundle
    uri: string
    // a reloaded frame needs a fresh gui session, answers its uri, empty when the plugin has no page anymore
    reload: () => Promise<string>
    reloaded: () => Promise<void>
    release: Exec
    lost: Exec
    scroll: (deltaX: number, deltaY: number, deltaMode: number) => void
    // the device panel shows through where the page draws nothing
    transparent?: boolean
}

export interface WclapFrame extends Terminable {
    readonly iframe: HTMLIFrameElement
    readonly isTerminated: boolean
    listen(owner: Window): Subscription
}

// One plugin page in the wclap-frame.html shim: the message port, page traffic, saves and the parameter menu
export const WclapFrame = ({service, adapter, bundle, uri, reload, reloaded, release, lost, scroll, transparent}: WclapFrameConfig): WclapFrame => {
    const {project, engine} = service
    const {editing, midiLearning} = project
    const uuid = adapter.uuid
    const uuidString = UUID.toString(uuid)
    const page = pagePath(uri)
    const iframe: HTMLIFrameElement = <iframe style={{border: "none"}}/>
    const frameOrigin = new URL(FRAME_URL, location.href).origin
    const terminator = new Terminator()
    const saveTimer: { id: Optional<ReturnType<typeof setTimeout>> } = {id: undefined}
    const scheduleSave = () => {
        if (isDefined(saveTimer.id)) {return}
        saveTimer.id = setTimeout(() => {
            saveTimer.id = undefined
            engine.wclapSaveState(uuid)
        }, SAVE_DELAY_MS)
    }
    const vitals = terminator.own(new VitalSigns())
    const connection = terminator.own(new Terminator())
    const link: { port: Option<MessagePort>, loads: number, pointer: boolean } = {port: Option.None, loads: 0, pointer: false}
    const post = (message: object): void => link.port.ifSome(port => port.postMessage(message))
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
        if (message.type === "wclap-message") {
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
        } else if (message.type === "wclap-wheel") {
            scroll(message.deltaX, message.deltaY, message.deltaMode)
        }
    }
    // a moved iframe reloads: the page gets a fresh gui session
    const reopen = async (port: MessagePort): Promise<void> => {
        const reopened = await reload()
        if (vitals.isTerminated) {return release()}
        if (!link.port.contains(port)) {return}
        if (reopened.length === 0) {return lost()}
        post({type: "wclap-open", uuid: uuidString, page: pagePath(reopened), files: bundle.files, transparent: transparent === true})
        if (link.pointer) {post({type: "wclap-pointer-enable"})}
        return reloaded()
    }
    const connect = (port: MessagePort): void => {
        connection.terminate()
        link.port = Option.wrap(port)
        connection.ownAll(
            Events.subscribe(port, "message", (event: MessageEvent) => {if (isFrameMessage(event.data)) {onFrameMessage(event.data)}}),
            {terminate: () => {
                port.close()
                link.port = Option.None
            }}
        )
        port.start()
        if (link.loads++ === 0) {
            post({type: "wclap-open", uuid: uuidString, page, files: bundle.files, transparent: transparent === true})
        } else {
            reopen(port).catch(error => RuntimeNotifier.notify({message: `Could not reconnect the plugin window: ${error}`, icon: "Warning"}))
        }
    }
    // a sample from the browser reaches the page as a dropped wav file: while it is dragged, the frame lets the
    // drag through to its parent, which relays the position and the file to the frame
    const sampleDrag = terminator.own(new Terminator())
    const framePoint = (event: DragEvent): Option<{ x: number, y: number }> => {
        const rect = iframe.getBoundingClientRect()
        const x = event.clientX - rect.left, y = event.clientY - rect.top
        return x >= 0 && y >= 0 && x < rect.width && y < rect.height ? Option.wrap({x, y}) : Option.None
    }
    const dropSample = (sample: Sample, x: number, y: number): void => {
        service.sampleManager.getAudioData(UUID.parse(sample.uuid)).then(audio => {
            const bytes = WavFile.encodeFloats({
                frames: audio.frames.slice(), sampleRate: audio.sampleRate,
                numberOfFrames: audio.numberOfFrames, numberOfChannels: audio.numberOfChannels
            })
            post({type: "wclap-drop", x, y, file: new File([bytes], `${sample.name}.wav`, {type: "audio/wav"})})
        }, reason => RuntimeNotifier.notify({message: `Could not load ${sample.name}: ${reason}`, icon: "Warning"}))
    }
    const dragSample = (sample: Sample): void => {
        const parent = iframe.parentElement
        if (!isDefined(parent) || link.port.isEmpty()) {return}
        sampleDrag.terminate()
        const over = {inside: false}
        const leave = (): void => {
            if (!over.inside) {return}
            over.inside = false
            post({type: "wclap-drag-leave"})
        }
        iframe.style.pointerEvents = "none"
        sampleDrag.ownAll(
            {terminate: () => {
                iframe.style.pointerEvents = ""
                leave()
            }},
            Events.subscribe(parent, "dragover", (event: DragEvent) => framePoint(event).match({
                none: leave,
                some: ({x, y}) => {
                    event.preventDefault()
                    if (isDefined(event.dataTransfer)) {event.dataTransfer.dropEffect = "copy"}
                    over.inside = true
                    post({type: "wclap-drag", x, y, name: sample.name})
                }
            })),
            Events.subscribe(parent, "dragleave", (event: DragEvent) => {if (framePoint(event).isEmpty()) {leave()}}),
            Events.subscribe(parent, "drop", (event: DragEvent) => {
                framePoint(event).ifSome(({x, y}) => {
                    event.preventDefault()
                    over.inside = false
                    dropSample(sample, x, y)
                })
                sampleDrag.terminate()
            }),
            // no pointer event reaches the page while a drag runs, the first one after means it ended
            Events.subscribe(iframe.ownerDocument, "dragend", () => sampleDrag.terminate(), {capture: true}),
            Events.subscribe(iframe.ownerDocument, "pointermove", () => sampleDrag.terminate(), {capture: true})
        )
    }
    terminator.ownAll(
        Events.subscribe(iframe.ownerDocument, "dragstart", () => DragAndDrop.current().ifSome(data => {
            if (data.type === "sample") {dragSample(data.sample)}
        })),
        WclapGuis.register(uuidString, bytes => post({type: "wclap-message", bytes})),
        WclapGuis.subscribeHovered(uuidString, paramId => {
            if (paramId < 0) {return}
            link.pointer = true
            post({type: "wclap-pointer-enable"})
        }),
        ContextMenu.subscribe(iframe, collector => {
            const parameter = menuParameter.parameter
            if (!isDefined(parameter)) {return}
            const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
            collector.addItems(MenuItem.header({label: parameter.name, icon: IconSymbol.WebClap, color: Colors.green}),
                ...parameterContextItems(editing, midiLearning, tracks, parameter))
        }),
        {
            terminate: () => {
                if (isDefined(saveTimer.id)) {clearTimeout(saveTimer.id)}
                engine.wclapSaveState(uuid)
                release()
            }
        }
    )
    iframe.src = FRAME_URL
    return {
        iframe,
        get isTerminated(): boolean {return vitals.isTerminated},
        listen: (owner: Window): Subscription => {
            connection.terminate()
            return Events.subscribe(owner, "message", (event: MessageEvent) => {
                if (event.source !== iframe.contentWindow || event.origin !== frameOrigin || !isFrameReady(event.data)) {return}
                const port = event.ports.at(0)
                if (isDefined(port)) {connect(port)}
            })
        },
        terminate: () => terminator.terminate()
    }
}
