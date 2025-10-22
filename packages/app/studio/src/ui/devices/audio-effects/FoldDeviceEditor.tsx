import css from "./FoldDeviceEditor.sass?inline"
import {DeviceHost, FoldDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle, TAU} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {Colors, EffectFactories} from "@opendaw/studio-core"
import {CanvasPainter} from "@/ui/canvas/painter"
import {dbToGain, wavefold} from "@opendaw/lib-dsp"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"

const className = Html.adoptStyleSheet(css, "FoldDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: FoldDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const FoldDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {drive} = adapter.namedParameter
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="oversampling">
                                  <h1>Oversampling</h1>
                                  <RadioGroup lifecycle={lifecycle}
                                              appearance={{framed: true}}
                                              model={EditWrapper.forValue(editing, adapter.box.overSampling)}
                                              elements={[
                                                  {value: 0, element: (<span>2</span>)},
                                                  {value: 1, element: (<span>4</span>)},
                                                  {value: 2, element: (<span>8</span>)}
                                              ]}/>
                              </div>
                              <canvas onInit={canvas => {
                                  const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                                      const scale = 16 // oversampling
                                      const {devicePixelRatio, context, actualWidth, actualHeight} = painter
                                      const w = actualWidth * scale
                                      const h2 = actualHeight * scale * 0.5
                                      const amountGain = dbToGain(drive.getValue())
                                      const toY = (value: number) => h2 - (h2 - devicePixelRatio * 2 * scale) * value
                                      context.save()
                                      context.scale(1.0 / scale, 1.0 / scale)
                                      context.lineWidth = devicePixelRatio * scale
                                      context.beginPath()
                                      context.moveTo(0, toY(0.0))
                                      context.lineTo(w, toY(0.0))
                                      context.strokeStyle = Colors.shadow
                                      context.stroke()
                                      context.beginPath()
                                      context.moveTo(0, toY(0.0))
                                      for (let x = 1; x <= w; x++) {
                                          context.lineTo(x, toY(wavefold(Math.sin(x / w * TAU), amountGain)))
                                      }
                                      context.strokeStyle = Colors.blue
                                      context.stroke()
                                      context.restore()
                                  }))
                                  lifecycle.own(drive.catchupAndSubscribe(() => painter.requestUpdate()))
                              }}/>
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter, parameter: drive, anchor: 0.0,
                                  style: {fontSize: "18px"}
                              })}
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.Fold.defaultIcon}/>
    )
}