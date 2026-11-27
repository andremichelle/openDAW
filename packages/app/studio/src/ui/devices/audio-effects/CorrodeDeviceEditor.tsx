import css from "./CorrodeDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, CorrodeDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DeviceEditor} from "@/ui/devices/DeviceEditor"
import {MenuItems} from "@/ui/devices/menu-items"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {CorrodeDisplay} from "./Corrode/CorrodeDisplay"

const className = Html.adoptStyleSheet(css, "CorrodeDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: CorrodeDeviceBoxAdapter
    deviceHost: DeviceHost
}

const ModeTooltips: ReadonlyArray<string> = [
    "One band-passed noise modulates both channels",
    "Independent band-passed noise per channel",
    "A sine at Freq modulates both channels"
]

export const CorrodeDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {mode, frequency, width, amount} = adapter.namedParameter
    const createControl = (parameter: AutomatableParameterFieldAdapter<number>): HTMLElement => (
        <div className="control">
            <h3>{parameter.name}</h3>
            <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                               tracks={deviceHost.audioUnitBoxAdapter().tracks} parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        </div>
    )
    const widthControl = createControl(width)
    lifecycle.own(mode.catchupAndSubscribe(owner =>
        widthControl.classList.toggle("disabled", owner.getControlledValue() === CorrodeDeviceBoxAdapter.SineMode)))
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="display">
                                  <CorrodeDisplay lifecycle={lifecycle} editing={editing} adapter={adapter}/>
                              </div>
                              <RadioGroup lifecycle={lifecycle}
                                          className="modes"
                                          model={EditWrapper.forAutomatableParameter(editing, mode)}
                                          elements={CorrodeDeviceBoxAdapter.Modes.map((name, index) => ({
                                              value: index, element: <span>{name}</span>, tooltip: ModeTooltips[index]
                                          }))}/>
                              {createControl(frequency)}
                              {widthControl}
                              {createControl(amount)}
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Corrode.defaultIcon}/>
    )
}
