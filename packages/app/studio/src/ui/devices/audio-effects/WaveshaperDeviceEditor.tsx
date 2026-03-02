import css from "./WaveshaperDeviceEditor.sass?inline"
import {DeviceHost, WaveshaperDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {CanvasPainter} from "@/ui/canvas/painter"
import {dbToGain, Waveshaper} from "@opendaw/lib-dsp"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "WaveshaperDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: WaveshaperDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const WaveshaperDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {inputGain, outputGain, mix} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="equation">
                                  <h1>Shape</h1>
                                  <RadioGroup lifecycle={lifecycle}
                                              appearance={{framed: true}}
                                              model={EditWrapper.forValue(editing, adapter.box.equation)}
                                              elements={Waveshaper.Equations.map(equation => ({
                                                  value: equation,
                                                  element: (<span>{equation}</span>)
                                              }))}/>
                              </div>
                              <canvas onInit={canvas => {
                                  const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                                      const {devicePixelRatio, context, actualWidth, actualHeight} = painter
                                      const range = 1.5
                                      const inputGainValue = dbToGain(inputGain.getControlledValue())
                                      const equation = (adapter.box.equation.getValue()) as Waveshaper.Equation
                                      const toX = (value: number) => ((value + range) / (2.0 * range)) * actualWidth
                                      const toY = (value: number) => ((range - value) / (2.0 * range)) * actualHeight
                                      context.save()
                                      context.lineWidth = devicePixelRatio
                                      context.beginPath()
                                      context.moveTo(toX(0), 0)
                                      context.lineTo(toX(0), actualHeight)
                                      context.moveTo(0, toY(0))
                                      context.lineTo(actualWidth, toY(0))
                                      context.strokeStyle = Colors.shadow.toString()
                                      context.stroke()
                                      context.beginPath()
                                      context.moveTo(toX(-range), toY(-range))
                                      context.lineTo(toX(range), toY(range))
                                      context.strokeStyle = DisplayPaint.strokeStyle(0.15)
                                      context.stroke()
                                      context.beginPath()
                                      const steps = actualWidth
                                      for (let px = 0; px <= steps; px++) {
                                          const x = -range + (px / steps) * 2.0 * range
                                          const y = Waveshaper.apply(x * inputGainValue, equation)
                                          if (px === 0) {
                                              context.moveTo(toX(x), toY(y))
                                          } else {
                                              context.lineTo(toX(x), toY(y))
                                          }
                                      }
                                      context.strokeStyle = DisplayPaint.strokeStyle(0.75)
                                      context.stroke()
                                      context.restore()
                                  }))
                                  lifecycle.ownAll(
                                      inputGain.catchupAndSubscribe(() => painter.requestUpdate()),
                                      adapter.box.equation.catchupAndSubscribe(() => painter.requestUpdate())
                                  )
                              }}/>
                              <div className="controls">
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: inputGain, anchor: 0.0,
                                      style: {gridColumn: "2"}
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: outputGain, anchor: 0.5,
                                      style: {gridColumn: "4"}
                                  })}
                                  {ControlBuilder.createKnob({
                                      lifecycle, editing, midiLearning, adapter, parameter: mix, anchor: 1.0,
                                      style: {gridColumn: "6"}
                                  })}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Waveshaper.defaultIcon}/>
    )
}
