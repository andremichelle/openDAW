import defaultCode from "./spielwerk-default.txt?raw"
import {DeviceHost, SpielwerkDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
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
