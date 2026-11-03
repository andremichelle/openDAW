import css from "./NoteFilterDeviceEditor.sass?inline"
import {DeviceHost, NoteFilterDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {EffectFactories} from "@opendaw/studio-core"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {
    ControlContext,
    createParameterInput,
    createParameterRow,
    createParameterToggle
} from "@/ui/devices/instruments/NanoDeviceEditor/ParameterControls"

const className = Html.adoptStyleSheet(css, "NoteFilterDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: NoteFilterDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const NoteFilterDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {min, max, set, transpose, key} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver} = project
    const controls: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    const valueName: HTMLElement = (<div className="name"/>)
    const transposeInput: HTMLElement = (<div className="swap">{createParameterInput(controls, transpose)}</div>)
    const keyInput: HTMLElement = (<div className="swap">{createParameterInput(controls, key)}</div>)
    lifecycle.own(set.catchupAndSubscribe(owner => {
        const isSet = owner.getValue()
        valueName.textContent = isSet ? key.name : transpose.name
        transposeInput.classList.toggle("inactive", isSet)
        keyInput.classList.toggle("inactive", !isSet)
    }))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="parameter-stack filter">
                                  <div className="label">Filter</div>
                                  {createParameterRow(controls, min)}
                                  {createParameterRow(controls, max)}
                              </div>
                              <div className="parameter-stack transpose">
                                  <div className="label">Transpose</div>
                                  <div className="name">{set.name}</div>
                                  {createParameterToggle(controls, set)}
                                  {valueName}
                                  <div className="swaps">
                                      {transposeInput}
                                      {keyInput}
                                  </div>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.NoteFilter.defaultIcon}/>
    )
}
