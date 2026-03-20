import defaultCode from "./apparat-default.js?raw"
import {DeviceHost, ApparatDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"
import {ApparatExamples} from "./apparat-examples"

const config: ScriptDeviceEditorConfig = {
    compiler: {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
    defaultCode,
    examples: ApparatExamples,
    icon: IconSymbol.Code,
    populateMenu: (parent, service, deviceHost) =>
        MenuItems.forAudioUnitInput(parent, service, deviceHost),
    populateMeter: ({lifecycle, service, adapter}) => (
        <DevicePeakMeter lifecycle={lifecycle}
                         receiver={service.project.liveStreamReceiver}
                         address={adapter.address}/>
    )
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ApparatDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ApparatDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => (
    <ScriptDeviceEditor lifecycle={lifecycle}
                        service={service}
                        adapter={adapter}
                        deviceHost={deviceHost}
                        config={config}/>
)
