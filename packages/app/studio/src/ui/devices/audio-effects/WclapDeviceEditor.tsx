import css from "./WclapDeviceEditor.sass?inline"
import {
    AutomatableParameterFieldAdapter,
    DeviceHost,
    InstrumentFactories,
    WclapAudioPort,
    WclapPluginInfo
} from "@opendaw/studio-adapters"
import {
    asInstanceOf,
    clamp,
    EmptyExec,
    isDefined,
    Lifecycle,
    Option,
    Optional,
    RuntimeNotifier,
    StringComparator,
    UUID
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Files, Html} from "@opendaw/lib-dom"
import {Colors, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {PointerField} from "@opendaw/lib-box"
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
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {WclapAdapter, WclapWindows} from "@/service/WclapWindows"
import {StoredWclapPlugin, WclapDescriber} from "@/service/WclapDescriber"
import {WclapNames} from "@/service/WclapNames"
import {OpenWclapAPI, WclapIndexFolder} from "@/opendaw-api"
import {ParameterTree, WclapParameterTree} from "@/ui/devices/audio-effects/WclapParameterTree"
import {populateSidechainMenu} from "@/ui/devices/SidechainButton"

const className = Html.adoptStyleSheet(css, "WclapDeviceEditor")

// One editor for both device kinds, the window lives in WclapWindows
type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WclapAdapter
    deviceHost: DeviceHost
}

const {kindOf} = WclapDescriber

type LabeledStoredPlugin = StoredWclapPlugin & { label: string }
type CloudPlugin = { uuid: string, label: string, info: WclapPluginInfo }
type CloudFolder = { name: string, folders: ReadonlyArray<CloudFolder>, plugins: ReadonlyArray<CloudPlugin> }

const EmptyCloudFolder: CloudFolder = {name: "", folders: [], plugins: []}

export const WclapDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project, engine} = service
    const {editing, midiLearning} = project
    const uuid = adapter.uuid
    const uuidString = UUID.toString(uuid)
    const {parameters: parametersField} = adapter.box
    const nameLabel: HTMLElement = <span className="name"/>
    const vendorLabel: HTMLElement = <span className="vendor"/>
    const state: {
        info: Optional<WclapPluginInfo>, ready: boolean, inputs: ReadonlyArray<WclapAudioPort>, credits: string
    } = {info: undefined, ready: false, inputs: [], credits: ""}
    const pluginBox: HTMLElement = (
        <div className="plugin" onclick={() => {
            if (state.credits.length > 0) {window.open(state.credits, "_blank", "noopener")}
        }}>{nameLabel}{vendorLabel}</div>
    )
    const showCredits = (url: string): void => {
        state.credits = ""
        pluginBox.classList.remove("linked")
        pluginBox.title = ""
        if (!WclapStorage.isLocal(url)) {return}
        OpenWclapAPI.get().find(WclapStorage.idOf(url)).then(entry => entry.ifSome(({credits}) => {
            if (adapter.urlField.getValue() !== url || credits.length === 0) {return}
            state.credits = credits
            pluginBox.classList.add("linked")
            pluginBox.title = credits
        }))
    }
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
        showCredits(url)
        if (clapId.length === 0) {return}
        describe(url).then(plugins => {
            if (adapter.clapIdField.getValue() !== clapId) {return}
            state.info = plugins.find(plugin => plugin.clapId === clapId)
            showName()
            if (isDefined(state.info) && state.ready) {vendorLabel.textContent = state.info.vendor}
        }, () => {})
    }
    // the latest pick wins, a download that finishes after another choice is dropped
    const pick = {generation: 0}
    const useCloud = (uuid: string, info: WclapPluginInfo): void => {
        const generation = ++pick.generation
        const current = (): boolean => generation === pick.generation
        nameLabel.classList.remove("empty")
        nameLabel.textContent = info.name
        vendorLabel.classList.remove("failed")
        // cloud ids are the archive's hash: a stored one is this very version, a newer version has another id
        WclapStorage.exists(uuid)
            .then(stored => {
                if (stored) {return WclapStorage.urlOf(uuid)}
                vendorLabel.textContent = "Downloading…"
                return OpenWclapAPI.get().load(uuid, progress => {
                    if (current()) {vendorLabel.textContent = `Downloading… ${Math.round(progress * 100)}%`}
                }).then(archive => WclapStorage.store(archive))
            })
            .then(local => {
                if (local !== WclapStorage.urlOf(uuid)) {throw new Error("the download does not match its id")}
                if (!current()) {return}
                if (isCurrent(local, info)) {
                    showPlugin()
                    return
                }
                select(local, info.clapId)
                refreshStored()
            })
            .catch(error => {
                if (!current()) {return}
                vendorLabel.classList.add("failed")
                vendorLabel.textContent = `Failed: ${error}`
                RuntimeNotifier.notify({message: `Could not download ${info.name}: ${error}`, icon: "Warning"})
            })
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
        const described: ReadonlyArray<WclapPluginInfo> = await describe(url).catch(error => {
            RuntimeNotifier.notify({message: `${file.name} is not a WebCLAP bundle: ${error}`, icon: "Warning"})
            return []
        })
        const plugins = described.filter(plugin => kindOf(plugin) === adapter.type)
        if (plugins.length === 0) {
            if (described.length > 0) {
                RuntimeNotifier.notify({
                    message: `${file.name} holds no ${adapter.type === "instrument" ? "instrument" : "audio effect"}`,
                    icon: "Warning"
                })
            }
            return
        }
        const shortNames = WclapNames.distinct(described.map(({name}) => name))
        const chosen: Option<WclapPluginInfo> = plugins.length === 1
            ? Option.wrap(plugins[0])
            : await Dialogs.select({
                headline: "Choose Plugin", message: `${file.name} holds ${plugins.length} plugins.`, okText: "Load",
                choices: plugins.map(plugin => ({text: shortNames[described.indexOf(plugin)], value: plugin}))
            })
        if (chosen.isEmpty()) {return}
        await WclapStorage.store(archive)
        refreshStored()
        select(url, chosen.unwrap().clapId)
    }
    // The hub notifies per child, so an earlier child's notification sees later children without an adapter yet
    const parameterOf = (paramBox: WclapParameterBox): Optional<AutomatableParameterFieldAdapter> =>
        adapter.parameters.parameters().find(parameter => parameter.address.equals(paramBox.value.address))
    // the input waits for the closing menu, which restores focus and would swallow the typed text
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
    const parametersMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        const entries = parametersField.pointerHub.incoming().flatMap(({box}) => {
            const paramBox = asInstanceOf(box, WclapParameterBox)
            const parameter = parameterOf(paramBox)
            return isDefined(parameter)
                ? [{module: paramBox.module.getValue(), name: paramBox.label.getValue(), value: parameter}] : []
        })
        const populate = (parent: MenuItem, tree: ParameterTree<AutomatableParameterFieldAdapter>): void => {
            parent.addMenuItem(...tree.groups.map(({label, tree: child}) =>
                MenuItem.default({label}).setRuntimeChildrenProcedure(sub => populate(sub, child))))
            parent.addMenuItem(...tree.items.map(({label, value}) => MenuItem.default({label})
                .setRuntimeChildrenProcedure(leaf => leaf.addMenuItem(...parameterItems(value)))))
        }
        populate(parent, WclapParameterTree.build(entries))
    })
    const byLabel = (a: { label: string }, b: { label: string }): number =>
        StringComparator(a.label.toLowerCase(), b.label.toLowerCase())
    const isCurrent = (url: string, {clapId}: WclapPluginInfo): boolean =>
        url === adapter.urlField.getValue() && clapId === adapter.clapIdField.getValue()
    const stored: { plugins: ReadonlyArray<LabeledStoredPlugin> } = {plugins: []}
    const refreshStored = (): void => {
        WclapDescriber.stored().then(plugins => {
            const urls = Array.from(new Set(plugins.map(({url}) => url)))
            stored.plugins = urls
                .flatMap(url => {
                    const bundle = plugins.filter(plugin => plugin.url === url)
                    const shortNames = WclapNames.distinct(bundle.map(({info}) => info.name))
                    return bundle.map((plugin, index) => {
                        const {vendor} = plugin.info
                        return {...plugin, label: vendor.length > 0 ? `${shortNames[index]} (${vendor})` : shortNames[index]}
                    })
                })
                .filter(({info}) => kindOf(info) === adapter.type)
                .toSorted(byLabel)
        }, EmptyExec)
    }
    const cloud: { root: CloudFolder, plugins: ReadonlyArray<CloudPlugin> } = {root: EmptyCloudFolder, plugins: []}
    OpenWclapAPI.get().tree().then(({folders}) => {
        const toFolder = ({name, folders, wclaps}: WclapIndexFolder): CloudFolder => ({
            name,
            folders: (folders ?? []).map(toFolder).filter(folder => folder.folders.length > 0 || folder.plugins.length > 0),
            plugins: (wclaps ?? [])
                .flatMap(({uuid, name, plugins}) => {
                    const shortNames = WclapNames.distinct(plugins.map(info => info.name))
                    return plugins.map((info, index) => ({uuid, label: plugins.length > 1 ? shortNames[index] : name, info}))
                })
                .filter(({info}) => kindOf(info) === adapter.type)
                .toSorted(byLabel)
        })
        cloud.root = toFolder({name: "", folders})
        const collect = ({folders, plugins}: CloudFolder): ReadonlyArray<CloudPlugin> => [...plugins, ...folders.flatMap(collect)]
        cloud.plugins = collect(cloud.root)
    }, EmptyExec)
    const populateCloud = (parent: MenuItem, {folders, plugins}: CloudFolder): void => {
        parent.addMenuItem(...folders.map(folder => MenuItem.default({label: folder.name, icon: IconSymbol.Folder})
            .setRuntimeChildrenProcedure(sub => populateCloud(sub, folder))))
        parent.addMenuItem(...plugins.map(({uuid, label, info}) =>
            MenuItem.default({label, checked: isCurrent(WclapStorage.urlOf(uuid), info)})
                .setTriggerProcedure(() => useCloud(uuid, info))))
    }
    const pluginMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        // a cloud plugin picked once is stored too, it stays listed under Cloud only
        const cloudUrls = new Set(cloud.plugins.map(({uuid}) => WclapStorage.urlOf(uuid)))
        const local = stored.plugins.filter(({url}) => !cloudUrls.has(url))
        parent.addMenuItem(
            MenuItem.default({label: "Cloud", icon: IconSymbol.CloudFolder, selectable: cloud.plugins.length > 0})
                .setRuntimeChildrenProcedure(sub => populateCloud(sub, cloud.root)),
            MenuItem.default({label: "Local", icon: IconSymbol.UserFolder, selectable: local.length > 0})
                .setRuntimeChildrenProcedure(sub => sub.addMenuItem(...local.map(({url, label, info}) =>
                    MenuItem.default({label, checked: isCurrent(url, info)})
                        .setTriggerProcedure(() => {
                            pick.generation++
                            select(url, info.clapId)
                        })))),
            MenuItem.default({label: "Import WebCLAP...", separatorBefore: true})
                .setTriggerProcedure(() => {
                    pick.generation++
                    browse()
                })
        )
        refreshStored()
    })
    const openLabel: HTMLElement = <span>Open UI</span>
    const openButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={() => WclapWindows.toggle(service, adapter, state.info?.name ?? adapter.labelField.getValue())}
                appearance={{
                    framed: true,
                    cursor: "pointer",
                    color: Colors.blue,
                    tooltip: "Show or hide the plugin's own window"
                }}>
            <span className="button-label">{openLabel}</span>
        </Button>
    )
    const parametersButton: HTMLElement = (
        <MenuButton root={parametersMenu}
                    appearance={{
                        framed: true,
                        color: Colors.shadow,
                        activeColor: Colors.white,
                        tooltip: "Automate, modulate or MIDI learn a parameter"
                    }}>
            <span className="button-label">Parameters</span>
        </MenuButton>
    )
    const pluginButtons: HTMLElement = <div className="group plugin">{openButton}{parametersButton}</div>
    const audioInMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => {
        if (adapter.type !== "instrument") {return}
        const fields = adapter.audioInputs
        const count = Math.min(state.inputs.length, fields.length)
        const menuOf = (sideChain: PointerField<Pointers.SideChain>) =>
            ({sideChain, rootBoxAdapter: project.rootBoxAdapter, editing, deviceHost})
        if (count === 1) {
            populateSidechainMenu(parent, menuOf(fields[0]))
            return
        }
        for (let index = 0; index < count; index++) {
            const {name} = state.inputs[index]
            parent.addMenuItem(MenuItem.default({
                label: name.length > 0 ? name : `Input ${index + 1}`,
                checked: fields[index].targetAddress.nonEmpty()
            }).setRuntimeChildrenProcedure(sub => populateSidechainMenu(sub, menuOf(fields[index]))))
        }
    })
    const audioInLabel: HTMLElement = <span className="button-label">Audio In</span>
    const audioInGroup: HTMLElement = (
        <div className="group hidden">
            <MenuButton root={audioInMenu}
                        appearance={{
                            framed: true,
                            color: Colors.shadow,
                            activeColor: Colors.white,
                            tooltip: "Route a track into the plugin's audio input"
                        }}>
                {audioInLabel}
            </MenuButton>
        </div>
    )
    const showAudioIn = (): void => {
        const connected = adapter.type === "instrument"
            && adapter.audioInputs.slice(0, state.inputs.length).some(field => field.targetAddress.nonEmpty())
        audioInLabel.classList.toggle("has-source", connected)
        audioInGroup.classList.toggle("hidden", adapter.type !== "instrument" || !state.ready || state.inputs.length === 0)
    }
    if (adapter.type === "instrument") {
        lifecycle.ownAll(...adapter.audioInputs.map(field => field.subscribe(showAudioIn)))
    }
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
            state.inputs = status.inputs
            showAudioIn()
            showStatus()
        }),
        WclapWindows.subscribe(uuidString, showStatus)
    )
    showStatus()
    refreshStored()
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
                              {pluginBox}
                              <div className="buttons">
                                  <div className="group">
                                      <MenuButton root={pluginMenu}
                                                  appearance={{
                                                      framed: true, color: Colors.shadow, activeColor: Colors.white,
                                                      tooltip: "Pick a plugin from the openDAW cloud or this device, or import one"
                                                  }}>
                                          <span className="button-label">Load Plugin</span>
                                      </MenuButton>
                                  </div>
                                  {pluginButtons}
                                  {audioInGroup}
                              </div>
                              <p className="about">
                                  Hosts a <a href="https://github.com/free-audio/web-clap" target="_blank"
                                             rel="noopener">WebCLAP</a> bundle,
                                  a CLAP plugin compiled to WebAssembly. Pick one from the openDAW cloud or import a
                                  .wclap.tar.gz from disk.
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
