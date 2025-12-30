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
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Colors} from "@opendaw/studio-enums"
import {VolumeSlider} from "@/ui/components/VolumeSlider"
import {Meters} from "@/ui/devices/audio-effects/Brick/Meters"
import {ControlIndicator} from "@/ui/components/ControlIndicator"

const className = Html.adoptStyleSheet(css, "BrickDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: BrickDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const BrickDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing} = project
    const {threshold} = adapter.namedParameter

    // PeakBroadcaster values: [peakL, peakR, rmsL, rmsR]
    const inputPeaks = new Float32Array(4)
    const outputPeaks = new Float32Array(4)
    const reduction = new Float32Array(1)
    lifecycle.ownAll(
        project.liveStreamReceiver.subscribeFloats(adapter.address.append(1), v => inputPeaks.set(v)),
        project.liveStreamReceiver.subscribeFloats(adapter.address, v => outputPeaks.set(v)),
        project.liveStreamReceiver.subscribeFloats(adapter.address.append(0), v => reduction.set(v))
    )

    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="slider-section">
                                  <ControlIndicator lifecycle={lifecycle} parameter={threshold}>
                                      <VolumeSlider lifecycle={lifecycle}
                                                    editing={editing}
                                                    parameter={threshold}/>
                                  </ControlIndicator>
                                  <div className="lookahead">
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
                              <Meters lifecycle={lifecycle}
                                      inputPeaks={inputPeaks}
                                      outputPeaks={outputPeaks}
                                      reduction={reduction}/>
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
