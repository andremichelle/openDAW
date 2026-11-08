import css from "./GuitarDeviceEditor.sass?inline"
import {Arrays, clamp, DefaultObservableValue, int, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {AutomatableParameterFieldAdapter, DeviceHost, GuitarDeviceBoxAdapter, GuitarPatterns, InstrumentFactories} from "@opendaw/studio-adapters"
import {MenuItem} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {MenuButton} from "@/ui/components/MenuButton"
import {NumberInput} from "@/ui/components/NumberInput"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Button} from "@/ui/components/Button"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {FretDisplay} from "@/ui/devices/instruments/GuitarDeviceEditor/FretDisplay"
import {GuitarStepGrid} from "@/ui/devices/instruments/GuitarDeviceEditor/GuitarStepGrid"

const className = Html.adoptStyleSheet(css, "GuitarDeviceEditor")

type Cell = { u: int, v: int }

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: GuitarDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const GuitarDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {
        mode, rate, speed, speedVariation, velocity, velocityVariation, swing, accent, position, tuning, body,
        damping, dampingVariation, pluck, pluckVariation, tension, spot, characterVariation, pick, spread, volume
    } = adapter.namedParameter
    const {project} = service
    const {editing, midiLearning} = project
    const {box} = adapter
    const tracks = deviceHost.audioUnitBoxAdapter().tracks
    const page = lifecycle.own(new DefaultObservableValue<int>(0))
    const lane = lifecycle.own(new DefaultObservableValue<int>(0))
    const brush = lifecycle.own(new DefaultObservableValue<int>(GuitarPatterns.Down))
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
    const section = (name: string, color: string, rows: [int, int], edge: string) => [
        <section className={edge} style={{gridRow: `${rows[0]} / ${rows[1]}`, "--color": color}}/>,
        <h3 className={Html.buildClassList("rotated", edge)}
            style={{gridArea: `${rows[0]} / -1 / ${rows[1]} / -1`, "--color": color}}>{name}</h3>
    ]
    const patternName: HTMLElement = <span/>
    lifecycle.own(box.pattern.catchupAndSubscribe(owner => patternName.textContent = GuitarPatterns.nameOf(owner.getValue())))
    const patternMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
        ...GuitarPatterns.Styles.map(style => MenuItem.default({label: style})
            .setRuntimeChildrenProcedure(styleParent => styleParent.addMenuItem(
                ...GuitarPatterns.Library
                    .map((pattern, index) => ({pattern, index}))
                    .filter(({pattern}) => pattern.style === style)
                    .map(({pattern, index}) => MenuItem.default({label: pattern.name, checked: index === box.pattern.getValue()})
                        .setTriggerProcedure(() => editing.modify(() => GuitarPatterns.load(box, index)))))))))
    const brushes: HTMLElement = (
        <div className="brushes">
            {GuitarPatterns.Kinds.map(({kind, glyph, label}) => {
                const cell: HTMLElement = (
                    <div className={Html.buildClassList(
                        (kind === GuitarPatterns.Mute || kind === GuitarPatterns.Chuck || kind === GuitarPatterns.Stop
                            || kind === GuitarPatterns.Rest) && "quiet")} title={label}>{glyph}</div>
                )
                lifecycle.ownAll(
                    Events.subscribe(cell, "click", () => brush.setValue(kind)),
                    brush.catchupAndSubscribe(owner => cell.classList.toggle("active", owner.getValue() === kind)))
                return cell
            })}
        </div>
    )
    const toolbar: HTMLElement = (
        <div className="toolbars">
            <div className="toolbar">
                <div className="field wide">
                    <MenuButton root={patternMenu} appearance={{tinyTriangle: true, color: Colors.dark}} pointer>
                        {patternName}
                    </MenuButton>
                </div>
                <div className="field">
                    <label>Length</label>
                    <NumberInput lifecycle={lifecycle} maxChars={2}
                                 guard={{guard: value => clamp(value, 1, GuitarPatterns.StepCount)}}
                                 model={EditWrapper.forValue(editing, box.patternLength)}/>
                </div>
                <div className="field">
                    <div className="group">
                        <Button lifecycle={lifecycle}
                                onClick={() => editing.modify(() => GuitarPatterns.rotate(box, 1))}
                                appearance={{framed: true, color: Colors.blue}}>{"<"}</Button>
                        <Button lifecycle={lifecycle}
                                onClick={() => editing.modify(() => GuitarPatterns.rotate(box, -1))}
                                appearance={{framed: true, color: Colors.blue}}>{">"}</Button>
                    </div>
                    <Button lifecycle={lifecycle}
                            onClick={() => editing.modify(() => GuitarPatterns.clear(box))}
                            appearance={{framed: true, color: Colors.green}}>Clear</Button>
                </div>
            </div>
            <div className="toolbar">
                <div className="field wide">{brushes}</div>
                <div className="field">
                    <label>Page</label>
                    <RadioGroup lifecycle={lifecycle} model={page}
                                elements={[0, 1, 2, 3].map(value => ({
                                    value, element: <span style={{margin: "0 1px"}}>{String(value + 1)}</span>
                                }))}/>
                </div>
            </div>
        </div>
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <FretDisplay lifecycle={lifecycle} project={project} adapter={adapter}/>
                              <div className="sequencer">
                                  {toolbar}
                                  <GuitarStepGrid lifecycle={lifecycle} editing={editing} adapter={adapter} page={page}
                                                  lane={lane} brush={brush} receiver={project.liveStreamReceiver}/>
                              </div>
                              <div className="labels">
                                  {section("STRUM", Colors.blue.toString(), [1, 7], "first")}
                                  {section("PLAY", Colors.purple.toString(), [7, 9], "middle")}
                                  {section("NECK", Colors.orange.toString(), [9, 11], "last")}
                                  {dragControl(speed, {u: 0, v: 0})}
                                  {dragControl(speedVariation, {u: 1, v: 0})}
                                  {dragControl(velocity, {u: 0, v: 2})}
                                  {dragControl(velocityVariation, {u: 1, v: 2})}
                                  {dragControl(swing, {u: 0, v: 4})}
                                  {dragControl(accent, {u: 1, v: 4})}
                                  {menuControl(mode, GuitarDeviceBoxAdapter.Modes.length, {u: 0, v: 6})}
                                  {menuControl(rate, GuitarDeviceBoxAdapter.Rates.length, {u: 1, v: 6})}
                                  {menuControl(position, 6, {u: 0, v: 8})}
                                  {menuControl(tuning, 4, {u: 1, v: 8})}
                              </div>
                              <div className="labels six">
                                  {section("PICK", Colors.yellow.toString(), [1, 7], "first")}
                                  {section("STRING", Colors.green.toString(), [7, 11], "middle")}
                                  {section("OUT", Colors.cream.toString(), [11, 13], "last")}
                                  {menuControl(pick, GuitarDeviceBoxAdapter.Picks.length, {u: 0, v: 0})}
                                  {dragControl(spot, {u: 1, v: 0})}
                                  {dragControl(pluck, {u: 0, v: 2})}
                                  {dragControl(pluckVariation, {u: 1, v: 2})}
                                  {dragControl(characterVariation, {u: 0, v: 4})}
                                  {dragControl(damping, {u: 0, v: 6})}
                                  {dragControl(dampingVariation, {u: 1, v: 6})}
                                  {dragControl(tension, {u: 0, v: 8})}
                                  {menuControl(body, GuitarDeviceBoxAdapter.Bodies.length, {u: 1, v: 8})}
                                  {dragControl(spread, {u: 0, v: 10})}
                                  {dragControl(volume, {u: 1, v: 10})}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Guitar.defaultIcon}/>
    )
}
