import css from "./GateDeviceEditor.sass?inline"
import {
    AutomatableParameterFieldAdapter,
    GateDeviceBoxAdapter,
    DeviceHost,
    LabeledAudioOutput
} from "@opendaw/studio-adapters"
import {Address} from "@opendaw/lib-box"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {GateDisplay} from "@/ui/devices/audio-effects/Gate/GateDisplay"
import {MenuButton} from "@/ui/components/MenuButton"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "GateDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: GateDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const GateDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {threshold, return: returnParam, attack, hold, release, floor} = adapter.namedParameter
    // [0] inputPeakDb, [1] outputPeakDb, [2] gateEnvelope, [3] thresholdDb
    const values = new Float32Array([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.0, -40.0])
    lifecycle.own(project.liveStreamReceiver.subscribeFloats(
        adapter.address.append(0), processorValues => values.set(processorValues)))
    const createLabelControlFrag = (parameter: AutomatableParameterFieldAdapter<number>) => (
        <Frag>
            <span>{parameter.name}</span>
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
        </Frag>
    )
    const sideChain = adapter.sideChain
    const createSideChainMenu = (parent: MenuItem) => {
        const isSelected = (address: Address) =>
            sideChain.targetAddress.mapOr(other => other.equals(address), false)
        const createSelectableItem = (output: LabeledAudioOutput): MenuItem => {
            if (output.children().nonEmpty()) {
                return MenuItem.default({label: output.label})
                    .setRuntimeChildrenProcedure(subParent =>
                        output.children().ifSome(children => {
                            for (const child of children) {
                                subParent.addMenuItem(createSelectableItem(child))
                            }
                        }))
            }
            return MenuItem.default({
                label: output.label,
                checked: isSelected(output.address)
            }).setTriggerProcedure(() => editing.modify(() =>
                sideChain.targetAddress = Option.wrap(output.address)))
        }
        sideChain.targetAddress.ifSome(() =>
            parent.addMenuItem(MenuItem.default({label: "Remove Sidechain"})
                .setTriggerProcedure(() => editing.modify(() =>
                    sideChain.targetAddress = Option.None))))
        parent.addMenuItem(MenuItem.header({label: "Tracks", icon: IconSymbol.OpenDAW, color: Colors.orange}))
        for (const output of project.rootBoxAdapter.labeledAudioOutputs()) {
            parent.addMenuItem(createSelectableItem(output))
        }
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="sidechain-row">
                                  <MenuButton onInit={button => sideChain.catchupAndSubscribe(pointer =>
                                      button.classList.toggle("has-source", pointer.nonEmpty()))}
                                              root={MenuItem.root().setRuntimeChildrenProcedure(createSideChainMenu)}
                                              appearance={{tinyTriangle: true}}>Sidechain</MenuButton>
                              </div>
                              <div className="control-section">
                                  <div className="controls">
                                      {[threshold, returnParam, floor]
                                          .map(parameter => createLabelControlFrag(parameter))}
                                  </div>
                                  <div className="controls">
                                      {[attack, hold, release]
                                          .map(parameter => createLabelControlFrag(parameter))}
                                  </div>
                              </div>
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
