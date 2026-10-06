import css from "./WclapDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DeviceHost, InstrumentFactories, WclapPluginInfo} from "@opendaw/studio-adapters"
import {
    asInstanceOf, clamp, EmptyExec, isDefined, Lifecycle, Option, Optional, RuntimeNotifier, UUID
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Files, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {WclapParameterBox} from "@opendaw/studio-boxes"
import {EffectFactories, MenuItem, WclapBundles, WclapStorage} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {parameterContextItems} from "@/ui/menu/automation.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {WclapAdapter, WclapWindows} from "@/service/WclapWindows"

const className = Html.adoptStyleSheet(css, "WclapDeviceEditor")

// One editor for both device kinds, the window lives in WclapWindows
type Kind = WclapAdapter["type"]

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WclapAdapter
    deviceHost: DeviceHost
}

type Example = { label: string, url: string, clapId: string, kind: Kind }
type ParameterGroup = { items: Array<MenuItem>, groups: Map<string, ParameterGroup> }

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

const kindOf = ({features}: WclapPluginInfo): Kind | "note-effect" =>
    features.includes("instrument") ? "instrument" : features.includes("note-effect") ? "note-effect" : "audio-effect"

export const WclapDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project, engine} = service
    const {editing, midiLearning} = project
    const uuid = adapter.uuid
    const uuidString = UUID.toString(uuid)
    const {parameters: parametersField} = adapter.box
    const nameLabel: HTMLElement = <span className="name"/>
    const vendorLabel: HTMLElement = <span className="vendor"/>
    const state: { info: Optional<WclapPluginInfo>, ready: boolean } = {info: undefined, ready: false}
    const describe = (url: string): Promise<ReadonlyArray<WclapPluginInfo>> =>
        url.length === 0 ? Promise.resolve([]) : engine.wclapDescribe(url)
    const select = (url: string, clapId: string): void => {
        editing.modify(() => {
            adapter.urlField.setValue(url)
            adapter.clapIdField.setValue(clapId)
        })
    }
    const showName = (): void => {
        const clapId = adapter.clapIdField.getValue()
        nameLabel.classList.toggle("empty", clapId.length === 0)
        nameLabel.textContent = clapId.length === 0 ? "No plugin loaded" : state.info?.name ?? clapId
    }
    const showPlugin = (): void => {
        const url = adapter.urlField.getValue()
        const clapId = adapter.clapIdField.getValue()
        state.info = undefined
        vendorLabel.textContent = ""
        vendorLabel.classList.remove("failed")
        showName()
        if (clapId.length === 0) {return}
        describe(url).then(plugins => {
            if (adapter.clapIdField.getValue() !== clapId) {return}
            state.info = plugins.find(plugin => plugin.clapId === clapId)
            showName()
            if (isDefined(state.info) && state.ready) {vendorLabel.textContent = state.info.vendor}
        }, () => {})
    }
    const useExample = ({label, url, clapId}: Example): void => {
        fetch(url)
            .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(`${response.status}`)))
            .then(archive => WclapStorage.store(archive))
            .then(local => select(local, clapId),
                error => RuntimeNotifier.notify({message: `Could not download ${label}: ${error}`, icon: "Warning"}))
    }
    const browse = async (): Promise<void> => {
        const files = await Files.open({
            types: [{description: "WebCLAP bundle", accept: {"application/gzip": [".gz", ".tgz"]}}], multiple: false
        }).catch(() => [])
        if (files.length === 0) {return}
        const file = files[0]
        const archive = await file.arrayBuffer()
        const url = await WclapStorage.urlFor(archive)
        WclapBundles.register(url, archive).catch(EmptyExec)
        const described = await describe(url).catch(error => {
            RuntimeNotifier.notify({message: `${file.name} is not a WebCLAP bundle: ${error}`, icon: "Warning"})
            return []
        })
        const plugins = described.filter(plugin => kindOf(plugin) === adapter.type)
        if (plugins.length === 0) {
            if (described.length > 0) {
                RuntimeNotifier.notify({message: `${file.name} holds no ${adapter.type === "instrument" ? "instrument" : "audio effect"}`, icon: "Warning"})
            }
            return
        }
        const chosen: Option<WclapPluginInfo> = plugins.length === 1
            ? Option.wrap(plugins[0])
            : await Dialogs.choose({
                headline: "Choose Plugin", message: file.name,
                choices: plugins.map(plugin => ({text: plugin.name, value: plugin}))
            })
        if (chosen.isEmpty()) {return}
        await WclapStorage.store(archive)
        select(url, chosen.unwrap().clapId)
    }
    // The hub notifies per child, so an earlier child's notification sees later children without an adapter yet
    const parameterOf = (paramBox: WclapParameterBox): Optional<AutomatableParameterFieldAdapter> =>
        adapter.parameters.parameters().find(parameter => parameter.address.equals(paramBox.value.address))
    // The plugin's own window is the only place to drag these, so the menu carries the numeric entry. The menu
    // lives in the same flyout and restores the previous focus while it closes, so the input waits for it, and
    // it opens where the pointer is, the menu is gone by then.
    const pointer = {x: 0, y: 0}
    const enterPercentage = (parameter: AutomatableParameterFieldAdapter): void => {
        const layers = Layers.get(parametersButton)
        const budget = {frames: 30}
        const open = (): void => {
            if (layers.hasFlyout && budget.frames-- > 0) {
                AnimationFrame.once(open)
                return
            }
            const origin = layers.flyout.getBoundingClientRect()
            const resolvers = Promise.withResolvers<string>()
            resolvers.promise.then(text => {
                const value = parseFloat(text)
                if (!isFinite(value)) {return}
                editing.modify(() => parameter.setUnitValue(clamp(value / 100.0, 0.0, 1.0)))
                editing.mark()
            }, EmptyExec)
            layers.flyout.appendChild(
                <FloatingTextInput position={{x: pointer.x - origin.left, y: pointer.y - origin.top}}
                                   value={(parameter.getUnitValue() * 100.0).toFixed(1)}
                                   unit="%"
                                   numeric
                                   resolvers={resolvers}/>
            )
        }
        AnimationFrame.once(open)
    }
    const parameterItems = (parameter: AutomatableParameterFieldAdapter): ReadonlyArray<MenuItem> => [
        MenuItem.default({label: "Enter Percentage..."}).setTriggerProcedure(() => enterPercentage(parameter)),
        ...parameterContextItems(editing, midiLearning, adapter.deviceHost().audioUnitBoxAdapter().tracks, parameter)
    ]
    // Every parameter under its CLAP module path ("osc/a"), each leaf carrying the usual parameter menu
    const parametersMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const root: ParameterGroup = {items: [], groups: new Map()}
        for (const {box} of parametersField.pointerHub.incoming()) {
            const paramBox = asInstanceOf(box, WclapParameterBox)
            const parameter = parameterOf(paramBox)
            if (!isDefined(parameter)) {continue}
            const group = paramBox.module.getValue().split("/").filter(name => name.length > 0)
                .reduce((group: ParameterGroup, name) => {
                    const existing = group.groups.get(name)
                    if (isDefined(existing)) {return existing}
                    const created: ParameterGroup = {items: [], groups: new Map()}
                    group.groups.set(name, created)
                    return created
                }, root)
            group.items.push(MenuItem.default({label: paramBox.label.getValue()})
                .setRuntimeChildrenProcedure(leaf => leaf.addMenuItem(...parameterItems(parameter))))
        }
        const populate = (parent: MenuItem, group: ParameterGroup): void => {
            parent.addMenuItem(...Array.from(group.groups, ([name, child]) =>
                MenuItem.default({label: name}).setRuntimeChildrenProcedure(sub => populate(sub, child))))
            parent.addMenuItem(...group.items)
        }
        populate(parent, root)
    })
    const examples = EXAMPLES.filter(example => example.kind === adapter.type)
    const examplesMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(...examples.map(example =>
        MenuItem.default({label: example.label, checked: example.clapId === adapter.clapIdField.getValue()})
            .setTriggerProcedure(() => useExample(example)))))
    const openLabel: HTMLElement = <span>Open UI</span>
    const openButton: HTMLElement = (
        <Button lifecycle={lifecycle} onClick={() => WclapWindows.toggle(service, adapter, state.info?.name ?? adapter.labelField.getValue())}
                appearance={{framed: true, cursor: "pointer", color: Colors.blue, tooltip: "Show or hide the plugin's own window"}}>
            <span className="button-label">{openLabel}</span>
        </Button>
    )
    const parametersButton: HTMLElement = (
        <MenuButton root={parametersMenu}
                    appearance={{framed: true, color: Colors.shadow, activeColor: Colors.white, tooltip: "Automate, modulate or MIDI learn a parameter"}}>
            <span className="button-label">Parameters</span>
        </MenuButton>
    )
    const pluginButtons: HTMLElement = <div className="group">{openButton}{parametersButton}</div>
    const showStatus = (): void => {
        openLabel.textContent = WclapWindows.isOpen(uuidString) ? "Close UI" : "Open UI"
        openButton.classList.toggle("disabled", !state.ready)
        parametersButton.classList.toggle("disabled", !state.ready)
    }
    lifecycle.ownAll(
        Events.subscribe(globalThis, "pointermove", (event: PointerEvent) => {
            pointer.x = event.clientX
            pointer.y = event.clientY
        }, {capture: true}),
        Events.subscribe(globalThis, "pointerdown", (event: PointerEvent) => {
            pointer.x = event.clientX
            pointer.y = event.clientY
        }, {capture: true}),
        adapter.clapIdField.catchupAndSubscribe(field => {
            pluginButtons.classList.toggle("hidden", field.getValue().length === 0)
            showPlugin()
        }),
        adapter.urlField.subscribe(showPlugin),
        engine.subscribeWclapStatus(uuidString, status => {
            state.ready = status.state === "ready"
            vendorLabel.classList.toggle("failed", status.state === "failed")
            vendorLabel.textContent = status.state === "ready"
                ? state.info?.vendor ?? ""
                : status.state === "failed" ? `Failed: ${status.message}` : status.message.length > 0 ? status.message : "Loading..."
            vendorLabel.title = status.message
            showStatus()
        }),
        WclapWindows.subscribe(uuidString, showStatus)
    )
    showStatus()
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
                                  <div className="group">
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
                                  </div>
                                  {pluginButtons}
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
