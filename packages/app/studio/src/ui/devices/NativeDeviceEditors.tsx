import css from "./NativeDeviceEditors.sass?inline"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceHost, NativeEffectBoxAdapter, NativeInstrumentBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NativeDeviceEditors")

// a host with native plugins installs its editor, everywhere else the device keeps its boxes and stays silent
// (an effect passes its audio through)
export namespace NativeDeviceEditors {
    export type Adapter = NativeInstrumentBoxAdapter | NativeEffectBoxAdapter
    export type Construct = { lifecycle: Lifecycle, service: StudioService, adapter: Adapter, deviceHost: DeviceHost }

    export const populateMenu = ({service, adapter, deviceHost}: Construct, parent: MenuItem): void => {
        if (adapter.type === "instrument") {
            MenuItems.forAudioUnitInput(parent, service, deviceHost)
        } else {
            MenuItems.forEffectDevice(parent, service, deviceHost, adapter)
        }
    }

    export const iconOf = (adapter: Adapter): IconSymbol => adapter.type === "instrument" ? IconSymbol.Piano : IconSymbol.Effects

    const state: { factory: Option<(construct: Construct) => JsxValue> } = {factory: Option.None}

    export const install = (factory: (construct: Construct) => JsxValue): void => {state.factory = Option.wrap(factory)}

    export const create = (construct: Construct): JsxValue =>
        state.factory.match({none: () => unavailable(construct), some: factory => factory(construct)})

    const unavailable = (construct: Construct): JsxValue => {
        const {lifecycle, service, adapter} = construct
        return (
            <DeviceEditor lifecycle={lifecycle}
                          service={service}
                          adapter={adapter}
                          populateMenu={parent => populateMenu(construct, parent)}
                          populateControls={() => (
                              <div className={className}>
                                  <span className="name">{adapter.pluginNameField.getValue()}</span>
                                  <span className="vendor">{adapter.vendorField.getValue()}</span>
                                  <p>VST not available in the browser</p>
                              </div>
                          )}
                          populateMeter={() => (
                              <DevicePeakMeter lifecycle={lifecycle}
                                               receiver={service.project.liveStreamReceiver}
                                               address={adapter.address}/>
                          )}
                          icon={iconOf(adapter)}/>
        )
    }
}
