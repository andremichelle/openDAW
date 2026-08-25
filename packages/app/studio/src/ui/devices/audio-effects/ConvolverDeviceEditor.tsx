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
import {LKR} from "@/ui/devices/constants"
import {SampleDropZone} from "@/ui/devices/SampleDropZone"
import {TextTooltip} from "@/ui/surface/TextTooltip"
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
    const {wet, dry, preDelay} = adapter.namedParameter
    const {normalize, reverse} = adapter.box
    const {project} = service
    const {editing, midiLearning} = project
    const maxSeconds = ConvolverDeviceBoxAdapter.MAX_IR_FRAMES / service.sampleRate
    const value: HTMLElement = (<span className="value"/>)
    const info: HTMLElement = (
        <div className="info">
            <Column ems={LKR} color={Colors.cream}>
                <h5>Duration</h5>
                {value}
            </Column>
        </div>
    )
    lifecycle.ownAll(
        adapter.box.file.catchupAndSubscribe(pointer => pointer.targetVertex.match({
            none: () => {
                value.textContent = "–"
                info.classList.remove("warning")
            },
            some: ({box}) => {
                const {startInSeconds, endInSeconds} = asInstanceOf(box, AudioFileBox)
                const seconds = endInSeconds.getValue() - startInSeconds.getValue()
                const truncated = seconds > maxSeconds
                value.textContent = truncated ? "Truncated" : `${seconds.toFixed(1)} s`
                info.classList.toggle("warning", truncated)
            }
        })),
        TextTooltip.default(info, () => info.classList.contains("warning")
            ? `Impulse responses longer than ${maxSeconds.toFixed(1)} s take too much CPU and are truncated`
            : `Impulse response duration (max ${maxSeconds.toFixed(1)} s)`)
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <SampleDropZone lifecycle={lifecycle} service={service} file={adapter.box.file}/>
                              {info}
                              <div className="toggles">
                                  {([
                                      {
                                          label: "Norm",
                                          field: normalize,
                                          icon: IconSymbol.AutoGain,
                                          tooltip: "Normalize impulse response"
                                      },
                                      {
                                          label: "Rev",
                                          field: reverse,
                                          icon: IconSymbol.Backward,
                                          tooltip: "Reverse impulse response"
                                      }
                                  ] as const).map(({label, field, icon, tooltip}) => (
                                      <Column ems={LKR} color={Colors.cream}>
                                          <h5>{label}</h5>
                                          <Checkbox lifecycle={lifecycle}
                                                    model={EditWrapper.forValue(editing, field)}
                                                    style={{marginTop: "2px"}}
                                                    appearance={{
                                                        color: Colors.cream,
                                                        activeColor: Colors.blue,
                                                        framed: false,
                                                        cursor: "pointer",
                                                        tooltip
                                                    }}>
                                              <Icon symbol={icon}/>
                                          </Checkbox>
                                      </Column>
                                  ))}
                              </div>
                              {[preDelay, wet, dry].map(parameter => ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter
                              }))}
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
