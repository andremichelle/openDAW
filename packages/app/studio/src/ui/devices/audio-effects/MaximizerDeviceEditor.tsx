import css from "./MaximizerDeviceEditor.sass?inline"
import {DeviceHost, MaximizerDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Events, Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"
import {MaximizerVolumeMarkers, VolumeSlider} from "@/ui/components/VolumeSlider"
import {Meters} from "@/ui/devices/audio-effects/Maximizer/Meters"
import {ControlIndicator} from "@/ui/components/ControlIndicator"

const className = Html.adoptStyleSheet(css, "MaximizerDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: MaximizerDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const MaximizerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
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
                              <Meters lifecycle={lifecycle}
                                      inputPeaks={inputPeaks}
                                      outputPeaks={outputPeaks}
                                      reduction={reduction}/>
                              <div className="lookahead" onInit={element => {
                                  lifecycle.ownAll(
                                      adapter.box.lookahead.catchupAndSubscribe(field =>
                                          element.classList.toggle("active", field.getValue())),
                                      Events.subscribe(element, "click", () =>
                                          editing.modify(() => adapter.box.lookahead.setValue(
                                              !adapter.box.lookahead.getValue())))
                                  )
                              }}>Lookahead
                              </div>
                              <div className="slider-section">
                                  <ControlIndicator lifecycle={lifecycle}
                                                    parameter={threshold}>
                                      <VolumeSlider lifecycle={lifecycle}
                                                    editing={editing}
                                                    parameter={threshold}
                                                    markers={MaximizerVolumeMarkers}/>
                                  </ControlIndicator>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Maximizer.defaultIcon}/>
    )
}
