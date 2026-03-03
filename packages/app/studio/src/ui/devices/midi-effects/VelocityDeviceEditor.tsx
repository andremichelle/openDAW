import css from "./VelocityDeviceEditor.sass?inline"
import {DeviceHost, VelocityDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Arrays, int, Lifecycle, linear, TAU, unitValue} from "@opendaw/lib-std"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {createElement} from "@opendaw/lib-jsx"
import {ControlBuilder} from "@/ui/devices/ControlBuilder.tsx"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {CanvasPainter} from "../../../../../../studio/core/src/ui/canvas/painter"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "VelocityDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: VelocityDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const VelocityDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, liveStreamReceiver, midiLearning} = project
    const {magnetPosition, magnetStrength, offset} = adapter.namedParameter
    const particleLifeTime = 20
    const velocities: Array<{ original: unitValue, computed: unitValue, lifeTime: int }> = []
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="header">
                                  <div className="canvas">
                                      <canvas onInit={canvas => {
                                          const painter = lifecycle.own(new CanvasPainter(canvas, painter => {
                                              const {context, devicePixelRatio, width, height} = painter
                                              const pad = 4
                                              const right = width - pad
                                              const bottom = height - pad
                                              context.save()
                                              context.scale(devicePixelRatio, devicePixelRatio)
                                              context.beginPath()
                                              context.setLineDash([2, 2])
                                              context.moveTo(pad, pad)
                                              context.lineTo(right, pad)
                                              context.moveTo(pad, bottom)
                                              context.lineTo(right, bottom)

                                              const gradient = context.createLinearGradient(pad, 0, right, 0)
                                              gradient.addColorStop(0.0, "hsla(200, 40%, 70%, 0.1)")
                                              gradient.addColorStop(1.0, "hsla(200, 40%, 70%, 0.3)")

                                              context.strokeStyle = gradient

                                              context.stroke()
                                              context.setLineDash(Arrays.empty())
                                              for (let i = velocities.length - 1; i >= 0; i--) {
                                                  const {original, computed} = velocities[i]
                                                  if (--velocities[i].lifeTime === 0) {
                                                      velocities.splice(i, 1)
                                                      continue
                                                  }
                                                  const x0 = pad + original * (width - pad * 2)
                                                  const x1 = pad + computed * (width - pad * 2)
                                                  context.beginPath()
                                                  const mu = 1.0 - velocities[i].lifeTime / particleLifeTime
                                                  context.arc(linear(x0, x1, mu), linear(pad, bottom, mu), 1, 0.0, TAU)
                                                  context.fillStyle = Colors.blue.toString()
                                                  context.fill()
                                              }

                                              const magPos = magnetPosition.getControlledValue()
                                              const magStr = magnetStrength.getControlledValue()
                                              const minMag = magPos * magStr
                                              const maxMag = 1.0 + (magPos - 1.0) * magStr

                                              // Magnet range
                                              context.beginPath()
                                              context.lineWidth = 1.0 / devicePixelRatio
                                              context.moveTo(pad + minMag * (width - pad * 2), bottom)
                                              context.lineTo(pad + maxMag * (width - pad * 2), bottom)
                                              context.strokeStyle = Colors.green.toString()
                                              context.stroke()

                                              // Magnet anchor
                                              context.strokeStyle = "none"
                                              context.beginPath()
                                              context.arc(pad + magPos * (width - pad * 2) - 1.0 / devicePixelRatio, bottom, 2, 0.0, TAU)
                                              context.fillStyle = Colors.green.toString()
                                              context.fill()

                                              context.restore()
                                          }))
                                          lifecycle.own(liveStreamReceiver.subscribeIntegers(adapter.address.append(0), array => {
                                              for (let i = 0; i < array.length; i++) {
                                                  const element = array[i]
                                                  if (element === 0) {break}
                                                  const original = element & 0xFF
                                                  const computed = (element >> 8) & 0xFF
                                                  velocities.push({
                                                      original: original / 127.0,
                                                      computed: computed / 127.0,
                                                      lifeTime: particleLifeTime
                                                  })
                                              }
                                              painter.requestUpdate()
                                          }))
                                      }}/>
                                  </div>
                                  <Icon symbol={IconSymbol.Magnet} style={{color: Colors.green.toString()}}/>
                                  <Icon symbol={IconSymbol.Random} style={{color: Colors.orange.toString()}}/>
                                  <Icon symbol={IconSymbol.Add} style={{color: Colors.yellow.toString()}}/>
                              </div>
                              {Object.values(adapter.namedParameter).map(parameter => ControlBuilder.createKnob({
                                  lifecycle,
                                  editing,
                                  midiLearning,
                                  adapter,
                                  parameter,
                                  anchor: parameter === offset ? 0.5 : 0.0
                              }))
                              }
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.Velocity.defaultIcon}/>
    )
}