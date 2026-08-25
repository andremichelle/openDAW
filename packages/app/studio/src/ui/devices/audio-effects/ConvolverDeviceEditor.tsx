import css from "./ConvolverDeviceEditor.sass?inline"
import {asInstanceOf, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ConvolverDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Icon} from "@/ui/components/Icon"
import {Column} from "@/ui/devices/Column"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {LKR} from "@/ui/devices/constants"
import {SampleSelector, SampleSelectStrategy} from "@/ui/devices/SampleSelector"
import {EffectFactories} from "@opendaw/studio-core"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "ConvolverDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ConvolverDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ConvolverDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {wet, dry, preDelay, normalize, reverse} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    const sampleDropZone: HTMLElement = (
        <div className="sample-drop">
            <Icon symbol={IconSymbol.Waveform}/>
        </div>
    )
    const sampleSelector = new SampleSelector(service, SampleSelectStrategy.forPointerField(adapter.box.file))
    lifecycle.ownAll(
        adapter.box.file.catchupAndSubscribe(pointer => pointer.targetVertex.match({
            none: () => sampleDropZone.removeAttribute("sample"),
            some: ({box}) => sampleDropZone.setAttribute("sample", asInstanceOf(box, AudioFileBox).fileName.getValue())
        })),
        sampleSelector.configureBrowseClick(sampleDropZone),
        sampleSelector.configureContextMenu(sampleDropZone),
        sampleSelector.configureDrop(sampleDropZone)
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {sampleDropZone}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: preDelay
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: wet
                              })}
                              {ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter: dry
                              })}
                              <div className="checkboxes">
                                  {([
                                      {label: "NRM", parameter: normalize, icon: IconSymbol.AutoGain},
                                      {label: "REV", parameter: reverse, icon: IconSymbol.Backward}
                                  ] as const).map(({label, parameter, icon}) => (
                                      <AutomationControl lifecycle={lifecycle}
                                                         editing={editing}
                                                         midiLearning={midiLearning}
                                                         tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                         parameter={parameter}>
                                          <Column ems={LKR.slice(2)} color={Colors.cream}>
                                              <h5>{label}</h5>
                                              <Checkbox lifecycle={lifecycle}
                                                        model={EditWrapper.forAutomatableParameter(editing, parameter)}
                                                        appearance={{
                                                            color: Colors.cream,
                                                            activeColor: Colors.blue,
                                                            framed: false,
                                                            cursor: "pointer"
                                                        }}>
                                                  <Icon symbol={icon}/>
                                              </Checkbox>
                                          </Column>
                                      </AutomationControl>
                                  ))}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Convolver.defaultIcon}/>
    )
}
