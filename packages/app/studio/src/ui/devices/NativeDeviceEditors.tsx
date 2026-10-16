import css from "./NativeDeviceEditors.sass?inline"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {DeviceHost, NativeInstrumentBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NativeDeviceEditors")

// a host with native plugins installs its editor, everywhere else the device keeps its boxes and stays silent
export namespace NativeDeviceEditors {
    export type Construct = { lifecycle: Lifecycle, service: StudioService, adapter: NativeInstrumentBoxAdapter, deviceHost: DeviceHost }

    const state: { factory: Option<(construct: Construct) => JsxValue> } = {factory: Option.None}

    export const install = (factory: (construct: Construct) => JsxValue): void => {state.factory = Option.wrap(factory)}

    export const create = (construct: Construct): JsxValue =>
        state.factory.match({none: () => unavailable(construct), some: factory => factory(construct)})

    const unavailable = ({lifecycle, service, adapter, deviceHost}: Construct): JsxValue => (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
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
                      icon={IconSymbol.Piano}/>
    )
}
