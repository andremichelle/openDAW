import defaultCode from "./spielwerk-default.txt?raw"
import {DeviceHost, SpielwerkDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {StudioService} from "@/service/StudioService"
import {SpielwerkExamples} from "./spielwerk-examples"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"

const config: ScriptDeviceEditorConfig = {
    compiler: {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"},
    defaultCode,
    examples: SpielwerkExamples,
    icon: IconSymbol.Code,
    populateMeter: () => null
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SpielwerkDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const SpielwerkDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => (
    <ScriptDeviceEditor lifecycle={lifecycle}
                        service={service}
                        adapter={adapter}
                        deviceHost={deviceHost}
                        config={config}/>
)
