import defaultCode from "./apparat-default.js?raw"
import starterPrompt from "./apparat-starter-prompt.txt?raw"
import viewsPrompt from "@/ui/devices/script-views-prompt.txt?raw"
import {DeviceHost, ApparatDeviceBoxAdapter, InstrumentFactories} from "@opendaw/studio-adapters"
import {asInstanceOf, Lifecycle} from "@opendaw/lib-std"
import {ApparatDeviceBox} from "@opendaw/studio-boxes"
import {createElement} from "@opendaw/lib-jsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"
import {ScriptEntryPointDocs} from "@/ui/devices/script-entry-points"

const config: ScriptDeviceEditorConfig = {
    compiler: {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
    defaultCode,
    communityTarget: "apparat",
    starterPrompt: `${starterPrompt}\n\n${viewsPrompt}`,
    entryPoints: ScriptEntryPointDocs.apparat,
    icon: IconSymbol.Code,
    renew: (box, uuid) => {
        const device = asInstanceOf(box, ApparatDeviceBox)
        const {defaultName, defaultIcon} = InstrumentFactories.Apparat
        return ApparatDeviceBox.create(device.graph, uuid, fresh => {
            fresh.host.refer(device.host.targetVertex.unwrap("apparat host"))
            fresh.label.setValue(defaultName)
            fresh.icon.setValue(IconSymbol.toName(defaultIcon))
        })
    },
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
