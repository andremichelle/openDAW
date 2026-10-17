import css from "./NativeInstrumentEditor.sass?inline"
import {UUID} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {ParametersMenu} from "@/ui/devices/ParametersMenu"
import {NativeDeviceEditors} from "@/ui/devices/NativeDeviceEditors"
import {NativePluginHost} from "@/platform/desktop/NativePluginHost"

const className = Html.adoptStyleSheet(css, "NativeInstrumentEditor")

const StatusText = {loading: "Loading…", failed: "Could not load the plugin"} as const

export const NativeInstrumentEditor = (construct: NativeDeviceEditors.Construct): JsxValue => {
    const {lifecycle, service, adapter} = construct
    const {project} = service
    const kind = adapter.type === "instrument" ? "instrument" : "effect"
    const uuid = UUID.toString(adapter.uuid)
    const nameLabel: HTMLElement = <span className="name"/>
    const vendorLabel: HTMLElement = <span className="vendor"/>
    const openLabel: HTMLElement = <span>Open UI</span>
    const openButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={() => NativePluginHost.toggleWindow(uuid)}
                appearance={{framed: true, cursor: "pointer", color: Colors.blue, tooltip: "Show or hide the plugin's own window"}}>
            <span className="button-label">{openLabel}</span>
        </Button>
    )
    const parametersButton: HTMLElement = (
        <ParametersMenu lifecycle={lifecycle} project={project} parametersField={adapter.box.parameters}
                        parameters={adapter.parameters} tracks={() => adapter.deviceHost().audioUnitBoxAdapter().tracks}/>
    )
    const pluginMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
        ...NativePluginHost.plugins().filter(plugin => plugin.kind === kind && plugin.status === "ok").map(plugin =>
            MenuItem.default({label: plugin.name, checked: plugin.id === adapter.pluginIdField.getValue()})
                .setTriggerProcedure(() => {
                    if (plugin.id === adapter.pluginIdField.getValue()) {return}
                    NativePluginHost.openOnceReady(uuid)
                    project.editing.modify(() => {
                        adapter.box.state.setValue(new Int8Array(0))
                        adapter.formatField.setValue(plugin.format)
                        adapter.pluginIdField.setValue(plugin.id)
                        adapter.pluginNameField.setValue(plugin.name)
                        adapter.vendorField.setValue(plugin.vendor)
                    })
                }))))
    const update = (): void => {
        const status = NativePluginHost.status(uuid)
        const name = adapter.pluginNameField.getValue()
        nameLabel.textContent = name.length > 0 ? name : "No plugin loaded"
        nameLabel.classList.toggle("empty", name.length === 0)
        const processing = NativePluginHost.isProcessing(uuid)
        vendorLabel.textContent = status !== "ready" ? StatusText[status]
            : processing ? adapter.vendorField.getValue() : "Not processing audio, it may need a license or activation"
        vendorLabel.classList.toggle("failed", status === "failed" || (status === "ready" && !processing))
        openLabel.textContent = NativePluginHost.isOpen(uuid) ? "Close UI" : "Open UI"
        openButton.classList.toggle("disabled", status !== "ready")
        parametersButton.classList.toggle("disabled", status !== "ready")
    }
    lifecycle.ownAll(
        NativePluginHost.subscribe(update),
        adapter.pluginNameField.subscribe(update),
        adapter.vendorField.subscribe(update)
    )
    update()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => NativeDeviceEditors.populateMenu(construct, parent)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="plugin">{nameLabel}{vendorLabel}</div>
                              <div className="buttons">
                                  <div className="group">
                                      <MenuButton root={pluginMenu}
                                                  appearance={{
                                                      framed: true, color: Colors.shadow, activeColor: Colors.white,
                                                      tooltip: "Pick a plugin installed on this computer"
                                                  }}>
                                          <span className="button-label">Load Plugin</span>
                                      </MenuButton>
                                  </div>
                                  <div className="group plugin">{openButton}{parametersButton}</div>
                              </div>
                              <p className="about">Hosts a VST3 plugin installed on this computer.</p>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={NativeDeviceEditors.iconOf(adapter)}/>
    )
}
