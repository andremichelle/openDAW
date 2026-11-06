import css from "./ScaleMatrixDeviceEditor.sass?inline"
import {DeviceHost, ScaleMatrixDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {CanvasPainter, EffectFactories} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {
    ControlContext,
    createParameterRow,
    createParameterToggle
} from "@/ui/devices/instruments/NanoDeviceEditor/ParameterControls"

const className = Html.adoptStyleSheet(css, "ScaleMatrixDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ScaleMatrixDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ScaleMatrixDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {root, scale, follow} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver, engine, timelineBoxAdapter: {keyTrack}} = project
    const controls: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    const canvas: HTMLCanvasElement = <canvas/>
    const keyName: HTMLElement = <div className="key-name"/>
    const currentKey = (): Harmony.Key => follow.getValue() ? keyTrack.keyAt(engine.position.getValue()) : adapter.key
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context}) => {
        const {width, height} = canvas
        const cell = Math.floor(Math.min(width, height) / 12)
        const key = currentKey()
        keyName.textContent = Harmony.keyName(key)
        context.clearRect(0, 0, width, height)
        for (let input = 0; input < 12; input++) {
            const output = ((Harmony.quantise(60 + input, key) - 60) % 12 + 12) % 12
            for (let row = 0; row < 12; row++) {
                const x = input * cell
                const y = (11 - row) * cell
                const black = MidiKeys.isBlackKey(input) || MidiKeys.isBlackKey(row)
                context.fillStyle = (row === output
                    ? (row === key.root ? Colors.orange : Colors.green)
                    : black ? Colors.panelBackgroundDark : Colors.panelBackgroundBright).toString()
                context.fillRect(x + 1, y + 1, cell - 2, cell - 2)
            }
        }
    }))
    lifecycle.ownAll(
        root.subscribe(painter.requestUpdate),
        scale.subscribe(painter.requestUpdate),
        follow.subscribe(painter.requestUpdate),
        keyTrack.subscribe(painter.requestUpdate),
        engine.position.subscribe(() => {if (follow.getValue()) {painter.requestUpdate()}})
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="grid">
                                  {canvas}
                                  {keyName}
                              </div>
                              <div className="parameter-stack scale">
                                  <div className="label">Scale</div>
                                  {createParameterRow(controls, root)}
                                  {createParameterRow(controls, scale)}
                                  <div className="name">{follow.name}</div>
                                  {createParameterToggle(controls, follow)}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.ScaleMatrix.defaultIcon}/>
    )
}
