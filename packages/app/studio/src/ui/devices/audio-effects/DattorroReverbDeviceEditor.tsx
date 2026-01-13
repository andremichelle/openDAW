import css from "./DattorroReverbDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DattorroReverbDeviceBoxAdapter, DeviceHost} from "@moises-ai/studio-adapters"
import {Color, int, Lifecycle} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@moises-ai/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@moises-ai/studio-core"
import {ControlGroup} from "@/ui/devices/ControlGroup"
import {Display} from "@/ui/devices/audio-effects/DattorroReverb/Display"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "DattorroReverbDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: DattorroReverbDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const DattorroReverbDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver} = project
    const createKnob = (parameter: AutomatableParameterFieldAdapter<number>, u: int, v: int, color?: Color) =>
        ControlBuilder.createKnob({
            lifecycle, editing, midiLearning, adapter, parameter, style: {gridArea: `${v + 1}/${u + 1}`}, color
        })
    const {
        decay, preDelay, bandwidth, damping,
        inputDiffusion1, inputDiffusion2, decayDiffusion1, decayDiffusion2, excursionRate, excursionDepth,
        dry, wet
    } = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {createKnob(preDelay, 0, 1)}
                              {createKnob(decay, 1, 1)}
                              {createKnob(damping, 2, 1)}
                              {createKnob(bandwidth, 0, 2)}
                              {createKnob(dry, 1, 2)}
                              {createKnob(wet, 2, 2)}
                              <Display lifecycle={lifecycle}
                                       liveStreamReceiver={liveStreamReceiver}
                                       adapter={adapter}
                                       gridUV={{u: 0, v: 0}}/>
                              <ControlGroup lifecycle={lifecycle}
                                            gridUV={{u: 3, v: 0}}
                                            color={Colors.blue}
                                            name="Input Diffusion"
                                            editing={editing}
                                            midiLearning={midiLearning}
                                            parameters={[inputDiffusion1, inputDiffusion2]}
                                            deviceAdapter={adapter}/>
                              <ControlGroup lifecycle={lifecycle}
                                            gridUV={{u: 3, v: 1}}
                                            color={Colors.green}
                                            name="Decay Diffusion"
                                            editing={editing}
                                            midiLearning={midiLearning}
                                            parameters={[decayDiffusion1, decayDiffusion2]}
                                            deviceAdapter={adapter}/>
                              <ControlGroup lifecycle={lifecycle}
                                            gridUV={{u: 3, v: 2}}
                                            color={Colors.purple}
                                            name="Excursion"
                                            editing={editing}
                                            midiLearning={midiLearning}
                                            parameters={[excursionRate, excursionDepth]}
                                            deviceAdapter={adapter}/>

                              {{/*Object.values(adapter.namedParameter).map(parameter => ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter
                              }))*/
                              }}
                          </div>)}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.DattorroReverb.defaultIcon}/>
    )
}