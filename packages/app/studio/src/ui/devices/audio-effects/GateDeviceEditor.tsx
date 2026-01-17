import css from "./GateDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DeviceHost, GateDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {GateDisplay} from "@/ui/devices/audio-effects/Gate/GateDisplay"
import {SidechainButton} from "@/ui/devices/SidechainButton"

const className = Html.adoptStyleSheet(css, "GateDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: GateDeviceBoxAdapter
    deviceHost: DeviceHost
}

// TODO
//  Use thresholdDb from adapter.
//  Draw threshold lines.
//  Show db labels.

export const GateDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {threshold, return: returnParam, attack, hold, release, floor} = adapter.namedParameter
    // [0] inputPeakDb, [1] outputPeakDb, [2] gateEnvelope, [3] thresholdDb
    const values = new Float32Array([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.0, -40.0])
    lifecycle.own(project.liveStreamReceiver.subscribeFloats(
        adapter.address.append(0), processorValues => values.set(processorValues)))
    const createLabelControlFrag = (parameter: AutomatableParameterFieldAdapter<number>) => (
        <div className="control">
            <h3>{parameter.name}</h3>
            <RelativeUnitValueDragging lifecycle={lifecycle}
                                       editing={editing}
                                       parameter={parameter}
                                       supressValueFlyout={true}>
                <ParameterLabel lifecycle={lifecycle}
                                editing={editing}
                                midiLearning={midiLearning}
                                adapter={adapter}
                                parameter={parameter}
                                framed standalone/>
            </RelativeUnitValueDragging>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <section className="envelope" style={{gridArea: "1 / 1 / 2 / 4"}}/>
                              {[attack, hold, release].map(parameter => createLabelControlFrag(parameter))}
                              <SidechainButton sideChain={adapter.sideChain}
                                               rootBoxAdapter={project.rootBoxAdapter}
                                               editing={editing}/>
                              {[threshold, returnParam, floor].map(parameter => createLabelControlFrag(parameter))}
                              <GateDisplay lifecycle={lifecycle} values={values}/>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Gate.defaultIcon}/>
    )
}
