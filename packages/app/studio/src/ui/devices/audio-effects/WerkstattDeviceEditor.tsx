import defaultCode from "./werkstatt-default.js?raw"
import starterPrompt from "./werkstatt-starter-prompt.txt?raw"
import viewsPrompt from "@/ui/devices/script-views-prompt.txt?raw"
import {DeviceHost, WerkstattDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, Lifecycle} from "@opendaw/lib-std"
import {WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {createElement} from "@opendaw/lib-jsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"
import {ScriptEntryPointDocs} from "@/ui/devices/script-entry-points"

const config: ScriptDeviceEditorConfig = {
    compiler: ScriptCompilers.Werkstatt,
    defaultCode,
    communityTarget: "werkstatt",
    starterPrompt: `${starterPrompt}\n\n${viewsPrompt}`,
    entryPoints: ScriptEntryPointDocs.werkstatt,
    icon: EffectFactories.AudioNamed.Werkstatt.defaultIcon,
    renew: (box, uuid) => {
        const device = asInstanceOf(box, WerkstattDeviceBox)
        return WerkstattDeviceBox.create(device.graph, uuid, fresh => {
            fresh.host.refer(device.host.targetVertex.unwrap("werkstatt host"))
            fresh.index.setValue(device.index.getValue())
            fresh.label.setValue(EffectFactories.AudioNamed.Werkstatt.defaultName)
        })
    },
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
