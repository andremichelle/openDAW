import css from "./StereoToolDeviceEditor.sass?inline"
import {DeviceHost, StereoToolDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {Colors, IconSymbol} from "@moises-ai/studio-enums"
import {Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {SnapCenter, SnapCommonDecibel} from "@/ui/configs"
import {LKR} from "@/ui/devices/constants"
import {Column} from "@/ui/devices/Column"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {Icon} from "@/ui/components/Icon"
import {ControlIndicator} from "@/ui/components/ControlIndicator"
import {AutoGainButton} from "@/ui/devices/audio-effects/StereoTool/AutoGainButton"
import {EffectFactories, MenuItem} from "@moises-ai/studio-core"
import {Mixing} from "@moises-ai/lib-dsp"
import {MenuItems} from "../menu-items"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "StereoToolDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: StereoToolDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const StereoToolDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {volume, panning, stereo, invertL, invertR, swap} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    const panningMixing = adapter.box.panningMixing
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => {
                          parent.addMenuItem(
                              MenuItem.default({label: "Panning"})
                                  .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                      MenuItems.createForValue(editing, "Linear", panningMixing, Mixing.Linear),
                                      MenuItems.createForValue(editing, "Equal Power", panningMixing, Mixing.EqualPower)
                                  )))
                          MenuItems.forEffectDevice(parent, service, deviceHost, adapter)
                      }}
                      populateControls={() => (
                          <div className={className}>
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: volume,
                                  options: SnapCommonDecibel
                              })}
                              <AutoGainButton lifecycle={lifecycle} project={project} adapter={adapter}/>
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: panning,
                                  options: SnapCenter,
                                  anchor: 0.5
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: stereo,
                                  options: SnapCenter,
                                  anchor: 0.5
                              })}
                              <div className="checkboxes">
                                  <Column ems={LKR.slice(2)} color={Colors.cream}>
                                      <h5>L-</h5>
                                      <ControlIndicator lifecycle={lifecycle} parameter={invertL}>
                                          <Checkbox lifecycle={lifecycle}
                                                    model={EditWrapper.forAutomatableParameter(editing, invertL)}
                                                    appearance={{
                                                        color: Colors.cream,
                                                        activeColor: Colors.red,
                                                        framed: false,
                                                        cursor: "pointer"
                                                    }}>
                                              <Icon symbol={IconSymbol.Invert}/>
                                          </Checkbox>
                                      </ControlIndicator>
                                  </Column>
                                  <Column ems={LKR.slice(2)} color={Colors.cream}>
                                      <h5>R-</h5>
                                      <ControlIndicator lifecycle={lifecycle} parameter={invertR}>
                                          <Checkbox lifecycle={lifecycle}
                                                    model={EditWrapper.forAutomatableParameter(editing, invertR)}
                                                    appearance={{
                                                        color: Colors.cream,
                                                        activeColor: Colors.red,
                                                        framed: false,
                                                        cursor: "pointer"
                                                    }}>
                                              <Icon symbol={IconSymbol.Invert}/>
                                          </Checkbox>
                                      </ControlIndicator>
                                  </Column>
                                  <Column ems={LKR.slice(2)} color={Colors.cream}>
                                      <h5>LR</h5>
                                      <ControlIndicator lifecycle={lifecycle} parameter={swap}>
                                          <Checkbox lifecycle={lifecycle}
                                                    model={EditWrapper.forAutomatableParameter(editing, swap)}
                                                    appearance={{
                                                        color: Colors.cream,
                                                        activeColor: Colors.blue,
                                                        framed: false,
                                                        cursor: "pointer"
                                                    }}>
                                              <Icon symbol={IconSymbol.Swap}/>
                                          </Checkbox>
                                      </ControlIndicator>
                                  </Column>
                              </div>
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.StereoTool.defaultIcon}/>
    )
}