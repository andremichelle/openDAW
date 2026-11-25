import defaultCode from "./spielwerk-default.js?raw"
import starterPrompt from "./spielwerk-starter-prompt.txt?raw"
import viewsPrompt from "@/ui/devices/script-views-prompt.txt?raw"
import {DeviceHost, SpielwerkDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, Lifecycle} from "@opendaw/lib-std"
import {SpielwerkDeviceBox} from "@opendaw/studio-boxes"
import {EffectFactories} from "@opendaw/studio-core"
import {createElement} from "@opendaw/lib-jsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {StudioService} from "@/service/StudioService"
import {ScriptDeviceEditor, ScriptDeviceEditorConfig} from "@/ui/devices/ScriptDeviceEditor"
import {ScriptCompilers} from "@/ui/devices/ScriptCompilers"
import {ScriptEntryPointDocs} from "@/ui/devices/script-entry-points"

const config: ScriptDeviceEditorConfig = {
    compiler: ScriptCompilers.Spielwerk,
    defaultCode,
    communityTarget: "spielwerk",
    starterPrompt: `${starterPrompt}\n\n${viewsPrompt}`,
    entryPoints: ScriptEntryPointDocs.spielwerk,
    icon: IconSymbol.Code,
    renew: (box, uuid) => {
        const device = asInstanceOf(box, SpielwerkDeviceBox)
        return SpielwerkDeviceBox.create(device.graph, uuid, fresh => {
            fresh.host.refer(device.host.targetVertex.unwrap("spielwerk host"))
            fresh.index.setValue(device.index.getValue())
            fresh.label.setValue(EffectFactories.MidiNamed.Spielwerk.defaultName)
        })
    },
    populateMenu: (parent, service, deviceHost, adapter) =>
        MenuItems.forEffectDevice(parent, service, deviceHost, adapter as SpielwerkDeviceBoxAdapter),
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
