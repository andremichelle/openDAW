import css from "./BrickDeviceEditor.sass?inline"
import {BrickDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "BrickDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: BrickDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const BrickDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {threshold} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: threshold,
                                  anchor: 1.0
                              })}
                              <div className="lookahead">
                                  <h1>Lookahead</h1>
                                  <Checkbox lifecycle={lifecycle}
                                            model={EditWrapper.forValue(editing, adapter.box.lookahead)}
                                            appearance={{
                                                color: Colors.cream,
                                                activeColor: Colors.orange,
                                                framed: true,
                                                cursor: "pointer"
                                            }}>5ms</Checkbox>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Brick.defaultIcon}/>
    )
}
