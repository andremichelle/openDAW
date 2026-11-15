import css from "./PitchDeviceEditor.sass?inline"
import {DeviceHost, PitchDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {createElement} from "@opendaw/lib-jsx"
import {ControlContext, createParameterRow} from "@/ui/devices/instruments/NanoDeviceEditor/ParameterControls"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "PitchDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: PitchDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const PitchDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {octaves, semiTones, cent} = adapter.namedParameter
    const {project} = service
    const {editing, liveStreamReceiver, midiLearning} = project
    const controls: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="parameter-stack pitch">
                                  <div className="label">Pitch</div>
                                  {createParameterRow(controls, octaves)}
                                  {createParameterRow(controls, semiTones)}
                                  {createParameterRow(controls, cent)}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.Pitch.defaultIcon}/>
    )
}