import css from "./ArpeggioDeviceEditor.sass?inline"
import {ArpeggioDeviceBoxAdapter, AutomatableParameterFieldAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Arrays, clamp, DefaultObservableValue, int, Lifecycle} from "@opendaw/lib-std"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {MenuButton} from "@/ui/components/MenuButton"
import {NumberInput} from "@/ui/components/NumberInput"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {StepGrid} from "@/ui/devices/midi-effects/ArpeggioDeviceEditor/StepGrid"
import {ArpeggioLanes} from "@/ui/devices/midi-effects/ArpeggioDeviceEditor/ArpeggioLanes"

const className = Html.adoptStyleSheet(css, "ArpeggioDeviceEditor")

type Cell = { u: int, v: int }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ArpeggioDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const ArpeggioDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {modeIndex, numOctaves, rate, gate, repeat, velocity, order, hold, retrigger, offset} = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    const {box} = adapter
    const tracks = deviceHost.audioUnitBoxAdapter().tracks
    const stepRange = lifecycle.own(new DefaultObservableValue<int>(16))
    const lane = lifecycle.own(new DefaultObservableValue<int>(0))
    const area = ({u, v}: Cell) => `${v + 1} / ${u + 1} / ${v + 3} / ${u + 2}`
    const label = (parameter: AutomatableParameterFieldAdapter) => (
        <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
    )
    const automated = (parameter: AutomatableParameterFieldAdapter, child: HTMLElement) => (
        <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                           tracks={tracks} parameter={parameter}>{child}</AutomationControl>
    )
    const dragControl = (parameter: AutomatableParameterFieldAdapter<number>, cell: Cell) => (
        <div className="control" style={{gridArea: area(cell)}}>
            <h3>{parameter.name}</h3>
            {automated(parameter, (
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter}
                                           supressValueFlyout={true}>
                    {label(parameter)}
                </RelativeUnitValueDragging>
            ))}
        </div>
    )
    const menuControl = (parameter: AutomatableParameterFieldAdapter<int>, count: int, cell: Cell) => (
        <div className="control" style={{gridArea: area(cell)}}>
            <h3>{parameter.name}</h3>
            {automated(parameter, (
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...Arrays.create(index => MenuItem.default({
                        label: parameter.stringMapping.x(index).value, checked: index === parameter.getValue()
                    }).setTriggerProcedure(() => editing.modify(() => parameter.setValue(index))), count)))}
                            pointer>
                    {label(parameter)}
                </MenuButton>
            ))}
        </div>
    )
    const toggleControl = (parameter: AutomatableParameterFieldAdapter<boolean>, cell: Cell) => (
        <div className="control" style={{gridArea: area(cell)}}>
            <h3>{parameter.name}</h3>
            {automated(parameter, (
                <div className="toggle" onclick={() => editing.modify(() => parameter.setValue(!parameter.getValue()))}>
                    {label(parameter)}
                </div>
            ))}
        </div>
    )
    const section = (name: string, color: string, rows: [int, int], edge: string) => [
        <section className={edge} style={{gridRow: `${rows[0]} / ${rows[1]}`, "--color": color}}/>,
        <h3 className={Html.buildClassList("rotated", edge)}
            style={{gridArea: `${rows[0]} / -1 / ${rows[1]} / -1`, "--color": color}}>{name}</h3>
    ]
    const toolbar: HTMLElement = (
        <div className="toolbar">
            <div className="field">
                <label>Length</label>
                <NumberInput lifecycle={lifecycle} maxChars={2}
                             guard={{guard: value => clamp(value, 1, ArpeggioDeviceBoxAdapter.StepCount)}}
                             model={EditWrapper.forValue(editing, box.patternLength)}/>
            </div>
            <div className="field">
                <label>Steps</label>
                <RadioGroup lifecycle={lifecycle} model={stepRange}
                            elements={[16, 32, 48, 64].map(value => ({
                                value, element: <span style={{margin: "0 1px"}}>{String(value)}</span>
                            }))}/>
            </div>
            <div className="field">
                <div className="group">
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => ArpeggioLanes.rotate(box, 1))}
                            appearance={{framed: true, color: Colors.blue}}>{"<"}</Button>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => ArpeggioLanes.rotate(box, -1))}
                            appearance={{framed: true, color: Colors.blue}}>{">"}</Button>
                </div>
                <Button lifecycle={lifecycle}
                        onClick={() => editing.modify(() => ArpeggioLanes.clear(box))}
                        appearance={{framed: true, color: Colors.green}}>Clear</Button>
            </div>
            <div className="field">
                <label>Seed</label>
                <NumberInput lifecycle={lifecycle} maxChars={6}
                             guard={{guard: value => clamp(value, 0, ArpeggioDeviceBoxAdapter.MaxSeed)}}
                             model={EditWrapper.forValue(editing, box.seed)}/>
                <Button lifecycle={lifecycle}
                        onClick={() => editing.modify(() =>
                            box.seed.setValue(Math.floor(Math.random() * ArpeggioDeviceBoxAdapter.MaxSeed)))}
                        appearance={{framed: true, color: Colors.orange, tooltip: "Reseed"}}>
                    <Icon symbol={IconSymbol.Random}/>
                </Button>
            </div>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              <div className="labels">
                                  {section("WALK", Colors.purple.toString(), [1, 5], "first")}
                                  {section("TIME", Colors.blue.toString(), [5, 9], "middle")}
                                  {section("NOTE", Colors.green.toString(), [9, 11], "last")}
                                  {menuControl(modeIndex, ArpeggioDeviceBoxAdapter.Modes.length, {u: 0, v: 0})}
                                  {menuControl(order, ArpeggioDeviceBoxAdapter.Orders.length, {u: 1, v: 0})}
                                  {dragControl(numOctaves, {u: 0, v: 2})}
                                  {toggleControl(hold, {u: 1, v: 2})}
                                  {dragControl(rate, {u: 0, v: 4})}
                                  {dragControl(repeat, {u: 1, v: 4})}
                                  {menuControl(retrigger, ArpeggioDeviceBoxAdapter.Retriggers.length, {u: 0, v: 6})}
                                  {dragControl(offset, {u: 1, v: 6})}
                                  {dragControl(gate, {u: 0, v: 8})}
                                  {dragControl(velocity, {u: 1, v: 8})}
                              </div>
                              <div className="sequencer">
                                  {toolbar}
                                  <StepGrid lifecycle={lifecycle} editing={editing} adapter={adapter}
                                            stepRange={stepRange} lane={lane} receiver={project.liveStreamReceiver}/>
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.MidiNamed.Arpeggio.defaultIcon}/>
    )
}