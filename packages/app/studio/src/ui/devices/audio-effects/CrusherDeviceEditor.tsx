import css from "./CrusherDeviceEditor.sass?inline"
import {CrusherDeviceBoxAdapter, DeviceHost} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"

const className = Html.adoptStyleSheet(css, "CrusherDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: CrusherDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const CrusherDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {Object.values(adapter.namedParameter)
                                  .map((parameter, index) => ControlBuilder.createKnob({
                                      lifecycle,
                                      editing,
                                      midiLearning,
                                      adapter,
                                      parameter,
                                      style: index % 2 === 1 ? {
                                          marginTop: "2.25em"
                                      } : {
                                          marginTop: "1.5em"
                                      }
                                  }))}
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Crusher.defaultIcon}/>
    )
}