import css from "./CompressorDeviceEditor.sass?inline"
import {
    AutomatableParameterFieldAdapter,
    CompressorDeviceBoxAdapter,
    DeviceHost,
    LabeledAudioOutputs
} from "@opendaw/studio-adapters"
import {Address} from "@opendaw/lib-box"
import {Lifecycle, Option} from "@opendaw/lib-std"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ParameterToggleButton} from "@/ui/devices/ParameterToggleButton"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {Meters} from "@/ui/devices/audio-effects/Compressor/Meters"
import {CompressionCurve} from "@/ui/devices/audio-effects/Compressor/CompressionCurve"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@/ui/model/menu-item"

const className = Html.adoptStyleSheet(css, "CompressorDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: CompressorDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const CompressorDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {
        lookahead, automakeup, autoattack, autorelease,
        threshold, ratio, knee, makeup,
        attack, release, inputgain, mix
    } = adapter.namedParameter
    const values = new Float32Array([Number.NEGATIVE_INFINITY, 0.0, Number.NEGATIVE_INFINITY])
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
            sideChain.targetAddress.mapOr(a => a.equals(address), false)
        const createSelectableItem = (address: Address, label: string, separatorBefore: boolean) =>
            MenuItem.default({label, separatorBefore, checked: isSelected(address)})
                .setTriggerProcedure(() => editing.modify(() =>
                    sideChain.targetAddress = Option.wrap(address)))
        // Remove current sidechain
        sideChain.targetAddress.ifSome(() =>
            parent.addMenuItem(MenuItem.default({label: "Remove Sidechain"})
                .setTriggerProcedure(() => editing.modify(() =>
                    sideChain.targetAddress = Option.None))))
        // Iterate over all audio units
        for (const audioUnit of project.rootBoxAdapter.audioUnits.adapters()) {
            audioUnit.input.getValue().ifSome(input => {
                parent.addMenuItem(MenuItem.default({
                    label: input.labelField.getValue()
                }).setRuntimeChildrenProcedure(subParent => {
                    // Input device (instrument or bus)
                    subParent.addMenuItem(createSelectableItem(
                        input.address, input.labelField.getValue(), false))
                    let separatorBefore = true
                    if (LabeledAudioOutputs.is(input)) {
                        for (const output of input.labeledAudioOutputs()) {
                            subParent.addMenuItem(createSelectableItem(
                                output.address, output.label, separatorBefore))
                            separatorBefore = false
                        }
                    }
                    // Audio effects
                    separatorBefore = true
                    for (const effect of audioUnit.audioEffects.adapters()) {
                        subParent.addMenuItem(createSelectableItem(
                            effect.address, effect.labelField.getValue(), separatorBefore))
                        separatorBefore = false
                        if (LabeledAudioOutputs.is(effect)) {
                            for (const output of effect.labeledAudioOutputs()) {
                                subParent.addMenuItem(createSelectableItem(
                                    output.address, output.label, false))
                            }
                        }
                    }
                    subParent.addMenuItem(createSelectableItem(
                        audioUnit.address, "Channelstrip", true))
                }))
            })
        }
    }
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="toggle-buttons">
                                  {[automakeup, autoattack, autorelease, lookahead]
                                      .map((parameter) => (
                                          <ParameterToggleButton lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={parameter}/>
                                      ))}
                                  <MenuButton onInit={button => sideChain.catchupAndSubscribe(pointer =>
                                      button.classList.toggle("has-source", pointer.nonEmpty()))}
                                              root={MenuItem.root().setRuntimeChildrenProcedure(createSideChainMenu)}
                                              appearance={{tinyTriangle: true}}>Sidechain</MenuButton>
                              </div>
                              <div className="control-section">
                                  <div className="controls">
                                      {[threshold, ratio, knee, makeup]
                                          .map(parameter => createLabelControlFrag(parameter))}
                                  </div>
                                  <div className="controls">
                                      {[attack, release, inputgain, mix]
                                          .map(parameter => createLabelControlFrag(parameter))}
                                  </div>
                              </div>
                              <CompressionCurve lifecycle={lifecycle} adapter={adapter} values={values}/>
                              <Meters lifecycle={lifecycle} values={values}/>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Compressor.defaultIcon}/>
    )
}