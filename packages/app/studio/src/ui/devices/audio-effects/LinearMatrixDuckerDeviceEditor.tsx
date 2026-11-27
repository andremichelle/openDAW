import css from "./LinearMatrixDuckerDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DeviceHost, LinearMatrixDuckerDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"
import {DeviceEditor} from "@/ui/devices/DeviceEditor"
import {MenuItems} from "@/ui/devices/menu-items"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {SidechainSelector} from "@/ui/devices/SidechainSelector"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {DuckerDisplay} from "@/ui/devices/audio-effects/LinearMatrixDucker/DuckerDisplay"
import {DuckerHistory} from "@/ui/devices/audio-effects/LinearMatrixDucker/DuckerHistory"

const className = Html.adoptStyleSheet(css, "LinearMatrixDuckerDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: LinearMatrixDuckerDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const LinearMatrixDuckerDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {attack, hold, release, mode, range, stereo, mix} = adapter.namedParameter
    const tracks = deviceHost.audioUnitBoxAdapter().tracks
    const history = new DuckerHistory(512)
    const display = (
        <DuckerDisplay lifecycle={lifecycle} editing={editing} adapter={adapter} history={history}
                       onPainter={painter => lifecycle.own(project.liveStreamReceiver.subscribeFloats(
                           adapter.address.append(0), values => {
                               if (history.receive(values) > 0) {painter.requestUpdate()}
                           }))}/>
    )
    const createTimeControl = (parameter: AutomatableParameterFieldAdapter<number>) => (
        <div className="time">
            <h3>{parameter.name}</h3>
            <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                               tracks={tracks} parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]}/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="screen">
                                  {display}
                                  <div className="times">{[attack, hold, release].map(createTimeControl)}</div>
                                  <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                                                     tracks={tracks} parameter={mode}>
                                      <RadioGroup lifecycle={lifecycle}
                                                  className="mode"
                                                  model={EditWrapper.forAutomatableParameter(editing, mode)}
                                                  elements={[
                                                      {value: 0, element: <span>PEAK</span>, tooltip: "Follows every sample peak"},
                                                      {value: 1, element: <span>ISP</span>, tooltip: "Catches peaks between samples (4x oversampled)"},
                                                      {value: 2, element: <span>RMS</span>, tooltip: "Follows the average level for a smoother response"}
                                                  ]}/>
                                  </AutomationControl>
                              </div>
                              <div className="column">
                                  {[range, stereo, mix].map(parameter => ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter,
                                      anchor: parameter === range ? 0.5 : 0.0
                                  }))}
                                  <SidechainSelector lifecycle={lifecycle}
                                                     editing={editing}
                                                     rootBoxAdapter={project.rootBoxAdapter}
                                                     sideChain={adapter.sideChain}
                                                     deviceHost={deviceHost}
                                                     label="Sidechain"/>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.LinearMatrixDucker.defaultIcon}/>
    )
}
