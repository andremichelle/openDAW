import defaultCode from "./werkstatt-default.js?raw"
import starterPrompt from "./werkstatt-starter-prompt.txt?raw"
import {DeviceHost, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {WerkstattExamples} from "./werkstatt-examples"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"

const config: ScriptDeviceEditorConfig = {
    compiler: {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
    defaultCode,
    examples: WerkstattExamples,
    starterPrompt,
    icon: EffectFactories.AudioNamed.Werkstatt.defaultIcon,
    populateMenu: (parent, service, deviceHost, adapter) =>
        MenuItems.forEffectDevice(parent, service, deviceHost, adapter as WerkstattDeviceBoxAdapter),
    populateMeter: ({lifecycle, service, adapter}) => (
        <DevicePeakMeter lifecycle={lifecycle}
                         receiver={service.project.liveStreamReceiver}
                         address={adapter.address}/>
    )
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WerkstattDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const WerkstattDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => (
    <ScriptDeviceEditor lifecycle={lifecycle}
                        service={service}
                        adapter={adapter}
                        deviceHost={deviceHost}
                        config={config}/>
)
