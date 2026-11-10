import css from "./ScaleMatrixDeviceEditor.sass?inline"
import {AutomatableParameterFieldAdapter, DeviceHost, ScaleMatrixDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {CanvasPainter, EffectFactories} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {
    ControlContext,
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
    const parameterInput = (parameter: AutomatableParameterFieldAdapter<number>) => (
        <div className="parameter">
            <div className="name">{parameter.name}</div>
            <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                               tracks={deviceHost.audioUnitBoxAdapter().tracks} parameter={parameter}>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter}
                                           supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={parameter} framed/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        </div>
    )
    const canvas: HTMLCanvasElement = <canvas/>
    const cells: HTMLElement = <div className="cells">{canvas}</div>
    const keyName: HTMLElement = <span/>
    const currentKey = (): Harmony.Key => follow.getValue() ? keyTrack.keyAt(engine.position.getValue()) : adapter.key
    let activity = 0
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context}) => {
        const {width, height} = canvas
        const cell = Math.floor(Math.min(width, height) / 12)
        const gap = Math.max(1, Math.round(cell * 0.12))
        const key = currentKey()
        keyName.textContent = adapter.isCustom ? `${MidiKeys.Names.English[key.root]} Custom` : Harmony.keyName(key)
        context.clearRect(0, 0, width, height)
        context.fillStyle = Colors.panelBackgroundDark.toString()
        context.fillRect(0, 0, cell * 12, cell * 12)
        const active = Colors.orange.opacity(0.75).toString()
        const playing = Colors.orange.toString()
        const white = Colors.shadow.opacity(0.25).toString()
        const black = Colors.shadow.opacity(0.08).toString()
        const heldWhite = Colors.shadow.opacity(0.4).toString()
        const heldBlack = Colors.shadow.opacity(0.2).toString()
        for (let column = 0; column < 12; column++) {
            const input = (key.root + column) % 12
            const output = adapter.outputClass(input, key)
            const held = (activity & (1 << input)) !== 0
            for (let row = 0; row < 12; row++) {
                const pitchClass = (key.root + row) % 12
                const isBlack = MidiKeys.isBlackKey(input) && MidiKeys.isBlackKey(pitchClass)
                context.fillStyle = pitchClass === output
                    ? (held && (activity & (1 << (12 + pitchClass))) !== 0 ? playing : active)
                    : held ? (isBlack ? heldBlack : heldWhite) : isBlack ? black : white
                context.fillRect(column * cell + gap, (11 - row) * cell + gap, cell - gap * 2, cell - gap * 2)
            }
        }
    }))
    const toggleCell = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect()
        const cell = rect.width / 12
        const column = Math.floor((event.clientX - rect.left) / cell)
        const row = 11 - Math.floor((event.clientY - rect.top) / cell)
        if (column < 0 || column > 11 || row < 0 || row > 11) {return}
        const key = currentKey()
        const input = (key.root + column) % 12
        const target = (key.root + row) % 12
        const offsetOf = (from: int, to: Nullable<int>): int => isDefined(to)
            ? ((to - from + 6) % 12 + 12) % 12 - 6 : ScaleMatrixDeviceBoxAdapter.Mute
        const fieldOf = (pitchClass: int) => adapter.box.custom.getField(((pitchClass - key.root) % 12 + 12) % 12)
        editing.modify(() => {
            if (!adapter.isCustom) {
                for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
                    fieldOf(pitchClass).setValue(offsetOf(pitchClass, adapter.outputClass(pitchClass, key)))
                }
                scale.setValue(ScaleMatrixDeviceBoxAdapter.CustomScale)
            }
            fieldOf(input).setValue(offsetOf(input, adapter.outputClass(input, key) === target ? null : target))
        })
    }
    lifecycle.ownAll(
        liveStreamReceiver.subscribeIntegers(adapter.address.append(0), array => {
            if (activity === array[0]) {return}
            activity = array[0]
            painter.requestUpdate()
        }),
        Events.subscribe(canvas, "pointerdown", toggleCell),
        ...adapter.box.custom.fields().map(field => field.subscribe(painter.requestUpdate)),
        Html.watchResize(cells, () => {
            const size = `${cells.clientHeight}px`
            canvas.style.width = size
            canvas.style.height = size
        }),
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
                              <div className="matrix">
                                  <header>
                                      {keyName}
                                      <div className="follow">
                                          <span>{follow.name}</span>
                                          {createParameterToggle(controls, follow)}
                                      </div>
                                  </header>
                                  {cells}
                              </div>
                              <div className="parameters">
                                  {parameterInput(root)}
                                  {parameterInput(scale)}
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
