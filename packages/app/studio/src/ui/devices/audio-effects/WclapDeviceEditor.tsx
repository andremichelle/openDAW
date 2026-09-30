import css from "./WclapDeviceEditor.sass?inline"
import {
    DeviceHost, InstrumentFactories, WclapDeviceBoxAdapter, WclapInstrumentBoxAdapter, WclapPluginInfo
} from "@opendaw/studio-adapters"
import {
    isDefined, Lifecycle, MutableObservableOption, Nullable, Option, Optional, RuntimeNotifier, Terminator, UUID
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {EffectFactories, MenuItem, WclapBundles, WclapGuis, WclapStorage} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {FloatingWindow, FloatingWindowHandle} from "@/ui/components/FloatingWindow.tsx"
import {StudioService} from "@/service/StudioService"
import {WclapResources} from "@/service/WclapResources"

const className = Html.adoptStyleSheet(css, "WclapDeviceEditor")

// One editor for both device kinds, the window and the relay are the same
type WclapAdapter = WclapDeviceBoxAdapter | WclapInstrumentBoxAdapter
type Kind = WclapAdapter["type"]

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WclapAdapter
    deviceHost: DeviceHost
}

type Example = { label: string, url: string, clapId: string, kind: Kind }

// Only plugins whose licence allows us to redistribute them (MIT, ISC)
const BASICS_URL = "https://raw.githubusercontent.com/WebCLAP/examples/main/signalsmith-basics/basics.wclap.tar.gz"
const CHAR_URL = "https://raw.githubusercontent.com/charCulbert/char-wclaps/main"
const EXAMPLES: ReadonlyArray<Example> = [
    {label: "Signalsmith Basics: Chorus", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.chorus", kind: "audio-effect"},
    {label: "Signalsmith Basics: Crunch", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.crunch", kind: "audio-effect"},
    {label: "Signalsmith Basics: Frequency Shifter", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.freq-shifter", kind: "audio-effect"},
    {label: "Signalsmith Basics: Limiter", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.limiter", kind: "audio-effect"},
    {label: "Signalsmith Basics: Reverb", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.reverb", kind: "audio-effect"},
    {label: "Signalsmith Basics: Analyser", url: BASICS_URL, clapId: "uk.co.signalsmith.basics.analyser", kind: "audio-effect"},
    {label: "Slide (Charlie Culbert)", url: `${CHAR_URL}/Slide.wclap.tar.gz`, clapId: "com.charlieculbert.slide", kind: "audio-effect"},
    {label: "MNO (Charlie Culbert)", url: `${CHAR_URL}/MNO.wclap.tar.gz`, clapId: "com.charlieculbert.mno", kind: "instrument"},
    {label: "Tapa (Charlie Culbert)", url: `${CHAR_URL}/tapa.wclap.tar.gz`, clapId: "com.charlieculbert.tapa", kind: "instrument"},
    {label: "Clap Saw Demo (Surge Synth Team)", url: `${CHAR_URL}/clap-saw-demo-imgui.wclap.tar.gz`, clapId: "org.surge-synth-team.clap-saw-demo", kind: "instrument"}
]

const DEFAULT_SIZE = {width: 640, height: 480}
const SAVE_DELAY_MS = 250

const kindOf = ({features}: WclapPluginInfo): Kind | "note-effect" =>
    features.includes("instrument") ? "instrument" : features.includes("note-effect") ? "note-effect" : "audio-effect"

// `file:///bundle/html/index.html?x` and `/ui/index.html` both name a bundle-root path (query kept)
const pagePath = (uri: string): string =>
    uri.startsWith("file:") ? uri.replace(/^file:\/*/, "/").split("/").slice(2).join("/") : uri.replace(/^\//, "")

const directoryOf = (path: string): string => path.includes("/") ? path.substring(0, path.lastIndexOf("/") + 1) : ""

const toArrayBuffer = (data: unknown): Nullable<ArrayBuffer> => {
    if (data instanceof ArrayBuffer) {return data}
    if (ArrayBuffer.isView(data)) {return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer}
    return null
}

export const WclapDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project, engine} = service
    const {editing} = project
    const uuid = adapter.uuid
    const uuidString = UUID.toString(uuid)
    const window = new MutableObservableOption<FloatingWindowHandle>()
    const nameLabel: HTMLElement = <span className="name"/>
    const vendorLabel: HTMLElement = <span className="vendor"/>
    const describe = (url: string): Promise<ReadonlyArray<WclapPluginInfo>> =>
        url.length === 0 ? Promise.resolve([]) : engine.wclapDescribe(url).catch(() => [])
    const select = (url: string, clapId: string): void => {
        editing.modify(() => {
            adapter.urlField.setValue(url)
            adapter.clapIdField.setValue(clapId)
        })
    }
    const showPlugin = (): void => {
        const url = adapter.urlField.getValue()
        const clapId = adapter.clapIdField.getValue()
        if (clapId.length === 0) {
            nameLabel.textContent = "No plugin loaded"
            nameLabel.classList.add("empty")
            vendorLabel.textContent = ""
            return
        }
        nameLabel.textContent = clapId
        nameLabel.classList.remove("empty")
        vendorLabel.textContent = ""
        describe(url).then(plugins => {
            if (adapter.clapIdField.getValue() !== clapId) {return}
            const info = plugins.find(plugin => plugin.clapId === clapId)
            if (!isDefined(info)) {return}
            nameLabel.textContent = info.name
            vendorLabel.textContent = info.vendor
        })
    }
    const browse = async (): Promise<void> => {
        const files = await Files.open({
            types: [{description: "WCLAP bundle", accept: {"application/gzip": [".gz", ".tgz"]}}], multiple: false
        }).catch(() => [])
        if (files.length === 0) {return}
        const file = files[0]
        const url = await WclapStorage.store(await file.arrayBuffer())
        const plugins = (await describe(url)).filter(plugin => kindOf(plugin) === adapter.type)
        if (plugins.length === 0) {
            RuntimeNotifier.notify({message: `${file.name} holds no ${adapter.type} plugin`, icon: "Warning"})
            return
        }
        const chosen: Option<WclapPluginInfo> = plugins.length === 1
            ? Option.wrap(plugins[0])
            : await Dialogs.choose({
                headline: "Choose Plugin", message: file.name,
                choices: plugins.map(plugin => ({text: plugin.name, value: plugin}))
            })
        chosen.ifSome(plugin => select(url, plugin.clapId))
    }
    const open = async (): Promise<void> => {
        if (window.nonEmpty()) {return}
        const gui = await engine.wclapOpenGui(uuid)
        if (gui.uri.length === 0) {
            RuntimeNotifier.notify({message: "Plugin is not ready yet", icon: "Warning"})
            return
        }
        const [bundle] = await Promise.all([WclapBundles.fetch(adapter.urlField.getValue()), WclapResources.ensure()])
        const page = pagePath(gui.uri)
        const iframe: HTMLIFrameElement = <iframe style={{border: "none", width: "100%", height: "100%"}}/>
        const session = new Terminator()
        // The plugin cannot time its own save (no timers in the worklet), so every page message schedules one
        const saveTimer: { id: Optional<ReturnType<typeof setTimeout>> } = {id: undefined}
        const scheduleSave = () => {
            if (isDefined(saveTimer.id)) {clearTimeout(saveTimer.id)}
            saveTimer.id = setTimeout(() => engine.wclapSaveState(uuid), SAVE_DELAY_MS)
        }
        session.own(WclapGuis.register(uuidString, bundle, directoryOf(page.split("?")[0]),
            bytes => iframe.contentWindow?.postMessage(bytes, "*")))
        session.own(Events.subscribe(globalThis, "message", (event: MessageEvent) => {
            if (event.source !== iframe.contentWindow) {return}
            const bytes = toArrayBuffer(event.data)
            if (!isDefined(bytes)) {return}
            engine.wclapReceive(uuid, bytes)
            scheduleSave()
        }))
        // Keyboard focus sits inside the plugin page while it is used, so the studio's shortcuts (save, undo)
        // would never see the key. The page is same-origin, forward every modifier-key press to the studio.
        session.own(Events.subscribe(iframe, "load", () => {
            const contentWindow = iframe.contentWindow
            if (!isDefined(contentWindow)) {return}
            for (const type of ["keydown", "keyup"] as const) {
                session.own(Events.subscribe(contentWindow, type, (event: KeyboardEvent) => {
                    if (!(event.metaKey || event.ctrlKey) || Events.isTextInput(event.target)) {return}
                    const forwarded = new KeyboardEvent(type, event)
                    globalThis.dispatchEvent(forwarded)
                    if (forwarded.defaultPrevented) {event.preventDefault()}
                }))
            }
        }))
        session.own({
            terminate: () => {
                if (isDefined(saveTimer.id)) {clearTimeout(saveTimer.id)}
                engine.wclapSaveState(uuid)
                engine.wclapCloseGui(uuid)
                window.clear()
            }
        })
        iframe.src = WclapResources.pageUrl(uuidString, page)
        const handle = FloatingWindow({
            title: nameLabel.textContent ?? adapter.labelField.getValue(),
            icon: IconSymbol.WebClap,
            width: gui.width > 0 ? gui.width : DEFAULT_SIZE.width,
            height: gui.height > 0 ? gui.height : DEFAULT_SIZE.height,
            onClose: () => session.terminate()
        }, iframe)
        window.wrap(handle)
    }
    const examples = EXAMPLES.filter(example => example.kind === adapter.type)
    const examplesMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(...examples.map(example =>
        MenuItem.default({label: example.label, checked: example.clapId === adapter.clapIdField.getValue()})
            .setTriggerProcedure(() => select(example.url, example.clapId)))))
    const openButton: HTMLElement = (
        <Button lifecycle={lifecycle} onClick={() => open()}
                appearance={{framed: true, cursor: "pointer", color: Colors.blue, tooltip: "Open the plugin's own window"}}>
            <span className="button-label">Open UI</span>
        </Button>
    )
    lifecycle.ownAll(
        {terminate: () => window.ifSome(handle => handle.close())},
        adapter.clapIdField.catchupAndSubscribe(field => {
            window.ifSome(handle => handle.close())
            openButton.classList.toggle("hidden", field.getValue().length === 0)
            showPlugin()
        })
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => {
                          if (adapter.type === "instrument") {
                              MenuItems.forAudioUnitInput(parent, service, deviceHost)
                          } else {
                              MenuItems.forEffectDevice(parent, service, deviceHost, adapter)
                          }
                      }}
                      populateControls={() => (
                          <div className={className}>
                              <div className="plugin">
                                  <span className="header">Plugin</span>
                                  {nameLabel}
                                  {vendorLabel}
                              </div>
                              <div className="buttons">
                                  <Button lifecycle={lifecycle} onClick={() => browse()}
                                          appearance={{
                                              framed: true, cursor: "pointer", color: Colors.shadow,
                                              activeColor: Colors.white, tooltip: "Load a .wclap.tar.gz from disk"
                                          }}>
                                      <Icon symbol={IconSymbol.Browse}/>
                                  </Button>
                                  <MenuButton root={examplesMenu}
                                              appearance={{framed: true, color: Colors.shadow, activeColor: Colors.white}}>
                                      <span className="button-label">Examples</span>
                                  </MenuButton>
                                  {openButton}
                              </div>
                              <p className="about">
                                  Hosts a <a href="https://github.com/free-audio/web-clap" target="_blank" rel="noopener">WebCLAP</a> bundle,
                                  a CLAP plugin compiled to WebAssembly. Load a .wclap.tar.gz from disk or pick an example.
                              </p>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={adapter.type === "instrument"
                          ? InstrumentFactories.Wclap.defaultIcon
                          : EffectFactories.AudioNamed.Wclap.defaultIcon}/>
    )
}
