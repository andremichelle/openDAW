import css from "./RevampDeviceEditor.sass?inline"
import {DeviceHost, Parameters, RevampDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asDefined, int, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {Column} from "@/ui/devices/Column.tsx"
import {ParameterLabel} from "@/ui/components/ParameterLabel.tsx"
import {createCurveRenderer, plotSpectrum} from "@/ui/devices/audio-effects/Revamp/Renderer.ts"
import {createDisplay} from "@/ui/devices/audio-effects/Revamp/Display.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {
    ColorSets,
    decibelValueGuide,
    ems,
    orderValueGuide,
    symbols,
    xAxis,
    yAxis
} from "@/ui/devices/audio-effects/Revamp/constants.ts"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {EditWrapper} from "@/ui/wrapper/EditWrapper.ts"
import {EffectFactories, LinearScale} from "@opendaw/studio-core"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "RevampDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: RevampDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const RevampDeviceEditor = ({adapter, service, lifecycle, deviceHost}: Construct) => {
    const {project} = service
    const curves: HTMLCanvasElement = <canvas/>
    const spectrum: HTMLCanvasElement = <canvas/>
    const spectrumContext = asDefined(spectrum.getContext("2d"))
    const spectrumScale = new LinearScale(-60.0, -3.0)
    lifecycle.ownAll(
        createCurveRenderer(curves, xAxis, yAxis, adapter),
        project.liveStreamReceiver.subscribeFloats(adapter.spectrum,
            values => plotSpectrum(spectrumContext, xAxis, spectrumScale, values, project.engine.sampleRate)))
    const grid: SVGSVGElement = <svg/>
    lifecycle.own(createDisplay(xAxis, yAxis, grid))
    const {editing, midiLearning} = project
    const {highPass, lowShelf, lowBell, midBell, highBell, highShelf, lowPass} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="default-screen" style={{gridArea: [1, 1, 3, -1].join("/")}}>
                                  {grid}
                                  {spectrum}
                                  {curves}
                                  <div className="switches">
                                      {[highPass, lowShelf, lowBell, midBell, highBell, highShelf, lowPass]
                                          .map((parameter: Parameters, index: int) => (
                                              <AutomationControl lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 midiLearning={midiLearning}
                                                                 tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                                 parameter={parameter.enabled}>
                                                  <Checkbox lifecycle={lifecycle}
                                                            model={EditWrapper.forAutomatableParameter(editing, parameter.enabled)}
                                                            appearance={{activeColor: ColorSets[index].full}}>
                                                      <Icon symbol={symbols[index]}/>
                                                  </Checkbox>
                                              </AutomationControl>
                                          ))}
                                  </div>
                              </div>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highPass.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highPass.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highPass.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highPass.order}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highPass.order}
                                                                 options={orderValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highPass.order}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highPass.q}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highPass.q}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highPass.q}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowShelf.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowShelf.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowShelf.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowShelf.gain}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowShelf.gain}
                                                                 options={decibelValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowShelf.gain}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowBell.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowBell.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowBell.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowBell.gain}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowBell.gain}
                                                                 options={decibelValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowBell.gain}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowBell.q}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowBell.q}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowBell.q}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={midBell.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={midBell.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={midBell.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={midBell.gain}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={midBell.gain}
                                                                 options={decibelValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={midBell.gain}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={midBell.q}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={midBell.q}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={midBell.q}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highBell.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highBell.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highBell.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highBell.gain}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highBell.gain}
                                                                 options={decibelValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highBell.gain}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highBell.q}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highBell.q}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highBell.q}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highShelf.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highShelf.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highShelf.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={highShelf.gain}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={highShelf.gain}
                                                                 options={decibelValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={highShelf.gain}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                              <Column ems={ems} space={0} color={Colors.cream}>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowPass.frequency}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowPass.frequency}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowPass.frequency}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowPass.order}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowPass.order}
                                                                 options={orderValueGuide}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowPass.order}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                                  <AutomationControl lifecycle={lifecycle}
                                                     editing={editing}
                                                     midiLearning={midiLearning}
                                                     tracks={deviceHost.audioUnitBoxAdapter().tracks}
                                                     parameter={lowPass.q}>
                                      <RelativeUnitValueDragging lifecycle={lifecycle}
                                                                 editing={editing}
                                                                 parameter={lowPass.q}>
                                          <ParameterLabel lifecycle={lifecycle}
                                                          parameter={lowPass.q}
                                                          framed/>
                                      </RelativeUnitValueDragging>
                                  </AutomationControl>
                              </Column>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Revamp.defaultIcon}/>
    )
}