import css from "./TidalDeviceEditor.sass?inline"
import {DeviceHost, TidalDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"
import {Display} from "@/ui/devices/audio-effects/Tidal/Display"

const className = Html.adoptStyleSheet(css, "TidalDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: TidalDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const TidalDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, liveStreamReceiver, midiLearning} = project
    const {rate, depth, slope, symmetry, offset, channelOffset} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <Display lifecycle={lifecycle} adapter={adapter} liveStreamReceiver={liveStreamReceiver}/>
                              {[rate, depth, slope, symmetry, offset, channelOffset]
                                  .map(parameter => ControlBuilder.createKnob<number | boolean>({
                                      lifecycle,
                                      editing,
                                      midiLearning,
                                      adapter,
                                      parameter,
                                      anchor: parameter.anchor,
                                      options: parameter === depth || parameter === slope ? {} : {snap: {threshold: 0.5}}
                                  }))}
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Tidal.defaultIcon}/>
    )
}