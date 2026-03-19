import defaultCode from "./werkstatt-default.txt?raw"
import {DeviceHost, WerkstattDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"
import {WerkstattExamples} from "./werkstatt-examples"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"

const config: ScriptDeviceEditorConfig = {
    compiler: {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
    defaultCode,
    examples: WerkstattExamples,
    icon: EffectFactories.AudioNamed.Werkstatt.defaultIcon,
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
