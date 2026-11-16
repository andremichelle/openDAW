import css from "./GuitarDeviceEditor.sass?inline"
import {Arrays, clamp, DefaultObservableValue, int, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Guitar} from "@opendaw/lib-dsp"
import {
    AutomatableParameterFieldAdapter, DeviceHost, Grooves, GuitarDeviceBoxAdapter, GuitarPatterns, InstrumentFactories
} from "@opendaw/studio-adapters"
import {ClipboardManager, MenuItem} from "@opendaw/studio-core"
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
import {GrooveMenus} from "@/ui/grooves/GrooveMenus"
import {PatternClipboard} from "@/ui/devices/PatternClipboard"

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
        mode, rate, speed, speedVariation, velocity, velocityVariation, tilt, position, tuning, body,
        damping, dampingVariation, pluck, pluckVariation, tension, spot, pick, spread, volume, slot, chord
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
    const grooveName: HTMLElement = <label className="groove"/>
    lifecycle.own(box.groove.catchupAndSubscribe(pointer => grooveName.textContent = pointer.targetVertex
        .mapOr(({box: target}) => Grooves.adapterOf(project, Grooves.asGrooveBox(target)).label, GrooveMenus.NoneLabel)))
    const grooveControl = (cell: Cell) => (
        <div className="control groove" style={{gridArea: area(cell)}}>
            <h3>Groove</h3>
            <MenuButton root={GrooveMenus.choiceRoot(project, box.groove)}
                        appearance={{tooltip: GrooveMenus.tooltip(project, box.groove), tinyTriangle: true}}
                        pointer>{grooveName}</MenuButton>
        </div>
    )
    const section = (name: string, color: string, rows: [int, int], edge: string) => [
        <section className={edge} style={{gridRow: `${rows[0]} / ${rows[1]}`, "--color": color}}/>,
        <h3 className={Html.buildClassList("rotated", edge)}
            style={{gridArea: `${rows[0]} / -1 / ${rows[1]} / -1`, "--color": color}}>{name}</h3>
    ]
    const current = lifecycle.own(new DefaultObservableValue<int>(slot.getControlledValue()))
    lifecycle.own(slot.subscribe(() => current.setValue(slot.getControlledValue())))
    const currentPattern = () => GuitarPatterns.slot(box, current.getValue())
    const patternName: HTMLElement = <span/>
    const lengthField: HTMLElement = <div className="field"/>
    const slotBound = lifecycle.own(new Terminator())
    const bindSlot = () => {
        slotBound.terminate()
        const {library, length} = currentPattern()
        slotBound.own(library.catchupAndSubscribe(owner =>
            patternName.textContent = GuitarPatterns.nameOf(owner.getValue())))
        replaceChildren(lengthField,
            <label>Length</label>,
            <NumberInput lifecycle={slotBound} maxChars={2}
                         guard={{guard: value => clamp(value, 1, GuitarPatterns.StepCount)}}
                         model={{
                             getValue: () => length.getValue(),
                             setValue: (value: int) => editing.modify(() => GuitarPatterns.setLength(currentPattern(), value)),
                             subscribe: observer => length.subscribe(observer),
                             catchupAndSubscribe: observer => length.catchupAndSubscribe(observer)
                         }}/>)
    }
    lifecycle.own(current.subscribe(bindSlot))
    bindSlot()
    const libraryItems = () => GuitarPatterns.Styles.map(style => MenuItem.default({label: style})
        .setRuntimeChildrenProcedure(styleParent => styleParent.addMenuItem(
            ...GuitarPatterns.Library
                .map((pattern, index) => ({pattern, index}))
                .filter(({pattern}) => pattern.style === style)
                .map(({pattern, index}) => MenuItem.default({label: pattern.name, checked: index === currentPattern().library.getValue()})
                    .setTriggerProcedure(() => editing.modify(() => GuitarPatterns.load(currentPattern(), index)))))))
    const snapshotTemplate = GuitarPatterns.snapshot(currentPattern())
    const PatternFormat: PatternClipboard.Format<GuitarPatterns.Snapshot> = {
        type: "guitar-pattern",
        valid: (value: unknown): value is GuitarPatterns.Snapshot => PatternClipboard.sameShape(snapshotTemplate, value)
    }
    const patternMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
        ...libraryItems(),
        MenuItem.default({label: "Copy Pattern", separatorBefore: true})
            .setTriggerProcedure(() => ClipboardManager.write(
                PatternClipboard.encode(PatternFormat, GuitarPatterns.snapshot(currentPattern())))),
        MenuItem.default({label: "Paste Pattern", selectable: PatternClipboard.pastable(PatternFormat)})
            .setTriggerProcedure(() => PatternClipboard.pasteFromMenu(PatternFormat, box,
                copied => editing.modify(() => GuitarPatterns.apply(currentPattern(), copied)))),
        MenuItem.default({label: "Clear Pattern"})
            .setTriggerProcedure(() => editing.modify(() => GuitarPatterns.clear(currentPattern())))))
    const menuOrder: ReadonlyArray<int> = GuitarPatterns.Styles.flatMap(style => GuitarPatterns.Library
        .map((pattern, index) => ({pattern, index}))
        .filter(({pattern}) => pattern.style === style)
        .map(({index}) => index))
    const walkPattern = (delta: int) => {
        const position = menuOrder.indexOf(currentPattern().library.getValue())
        const next = position === -1
            ? (delta > 0 ? 0 : menuOrder.length - 1)
            : (position + delta + menuOrder.length) % menuOrder.length
        editing.modify(() => GuitarPatterns.load(currentPattern(), menuOrder[next]))
    }
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
    const chordName: HTMLElement = <span/>
    const shapeAt = (index: int) => Guitar.unpackShape(box.shapes.getField(index).getValue())
    const writeShape = (frets: ReadonlyArray<int>) => {
        const index = chord.getControlledValue()
        if (index > 0) {editing.modify(() => box.shapes.getField(index - 1).setValue(Guitar.packShape(frets)))}
    }
    const chordTrackTab = (): Option<ReadonlyArray<int>> => project.timelineBoxAdapter.chordTrack
        .chordAt(project.engine.position.getValue())
        .map(({root, bits}) => Guitar.tab(root, bits, tuning.getControlledValue(), position.getControlledValue()))
    const chordMenu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
        MenuItem.default({label: "Chord Track", checked: chord.getControlledValue() === 0})
            .setTriggerProcedure(() => editing.modify(() => chord.setValue(0))),
        ...Arrays.create(index => {
            const frets = shapeAt(index)
            const label = Guitar.isEmptyShape(frets) ? `Shape ${index + 1}`
                : `Shape ${index + 1} · ${Guitar.shapeName(frets, tuning.getControlledValue())}`
            return MenuItem.default({label, checked: chord.getControlledValue() === index + 1, separatorBefore: index === 0})
                .setTriggerProcedure(() => editing.modify(() => chord.setValue(index + 1)))
        }, GuitarDeviceBoxAdapter.ShapeCount),
        MenuItem.default({
            label: "Copy Chord Track Voicing", separatorBefore: true,
            selectable: chord.getControlledValue() > 0 && chordTrackTab().nonEmpty()
        }).setTriggerProcedure(() => chordTrackTab().ifSome(writeShape)),
        MenuItem.default({label: "Clear Shape", selectable: chord.getControlledValue() > 0})
            .setTriggerProcedure(() => writeShape(new Array<int>(Guitar.Strings).fill(Guitar.Muted)))))
    lifecycle.own(chord.catchupAndSubscribe(owner => chordName.textContent =
        owner.getControlledValue() === 0 ? "Chord Track" : `Shape ${owner.getControlledValue()}`))
    const chordSelector: HTMLElement = automated(chord, (
        <MenuButton root={chordMenu} appearance={{tinyTriangle: true, color: Colors.shadow, tooltip: "Chord source"}} pointer>
            {chordName}
        </MenuButton>
    ))
    const toolbar: HTMLElement = (
        <div className="toolbars">
            <div className="toolbar">
                <div className="field">
                    <label>{slot.name}</label>
                    {automated(slot, (
                        <NumberInput lifecycle={lifecycle} mapper={slot.stringMapping}
                                     guard={{guard: value => clamp(value, 0, GuitarDeviceBoxAdapter.SlotCount - 1)}}
                                     model={EditWrapper.forAutomatableParameter(editing, slot)}/>
                    ))}
                </div>
                <div className="field wide menu">
                    <MenuButton root={patternMenu} appearance={{tinyTriangle: true, color: Colors.dark}} pointer stretch>
                        {patternName}
                    </MenuButton>
                </div>
                <div className="field">
                    <div className="group">
                        <Button lifecycle={lifecycle} onClick={() => walkPattern(-1)}
                                appearance={{framed: true, color: Colors.blue, tooltip: "Previous library pattern"}}>{"<"}</Button>
                        <Button lifecycle={lifecycle} onClick={() => walkPattern(1)}
                                appearance={{framed: true, color: Colors.blue, tooltip: "Next library pattern"}}>{">"}</Button>
                    </div>
                </div>
                {lengthField}
            </div>
            <div className="toolbar">
                <div className="field wide">{brushes}</div>
                <div className="field">
                    <div className="group">
                        <Button lifecycle={lifecycle}
                                onClick={() => editing.modify(() => GuitarPatterns.rotate(currentPattern(), 1))}
                                appearance={{framed: true, color: Colors.blue, tooltip: "Shift steps left"}}>{"<"}</Button>
                        <Button lifecycle={lifecycle}
                                onClick={() => editing.modify(() => GuitarPatterns.rotate(currentPattern(), -1))}
                                appearance={{framed: true, color: Colors.blue, tooltip: "Shift steps right"}}>{">"}</Button>
                    </div>
                </div>
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
                              <FretDisplay lifecycle={lifecycle} project={project} adapter={adapter} selector={chordSelector}/>
                              <div className="sequencer">
                                  {toolbar}
                                  <GuitarStepGrid lifecycle={lifecycle} editing={editing} adapter={adapter} page={page}
                                                  lane={lane} brush={brush} slot={current} receiver={project.liveStreamReceiver}/>
                              </div>
                              <div className="labels">
                                  {section("STRUM", Colors.blue.toString(), [1, 7], "first")}
                                  {section("PLAY", Colors.purple.toString(), [7, 9], "middle")}
                                  {section("NECK", Colors.orange.toString(), [9, 11], "last")}
                                  {dragControl(speed, {u: 0, v: 0})}
                                  {dragControl(speedVariation, {u: 1, v: 0})}
                                  {dragControl(velocity, {u: 0, v: 2})}
                                  {dragControl(velocityVariation, {u: 1, v: 2})}
                                  {grooveControl({u: 0, v: 4})}
                                  {dragControl(tilt, {u: 1, v: 4})}
                                  {menuControl(mode, GuitarDeviceBoxAdapter.Modes.length, {u: 0, v: 6})}
                                  {menuControl(rate, GuitarDeviceBoxAdapter.Rates.length, {u: 1, v: 6})}
                                  {menuControl(position, Guitar.PositionNames.length, {u: 0, v: 8})}
                                  {menuControl(tuning, Guitar.TuningNames.length, {u: 1, v: 8})}
                              </div>
                              <div className="labels">
                                  {section("PICK", Colors.yellow.toString(), [1, 5], "first")}
                                  {section("STRING", Colors.green.toString(), [5, 9], "middle")}
                                  {section("OUT", Colors.cream.toString(), [9, 11], "last")}
                                  {menuControl(pick, GuitarDeviceBoxAdapter.Picks.length, {u: 0, v: 0})}
                                  {dragControl(spot, {u: 1, v: 0})}
                                  {dragControl(pluck, {u: 0, v: 2})}
                                  {dragControl(pluckVariation, {u: 1, v: 2})}
                                  {dragControl(damping, {u: 0, v: 4})}
                                  {dragControl(dampingVariation, {u: 1, v: 4})}
                                  {dragControl(tension, {u: 0, v: 6})}
                                  {menuControl(body, GuitarDeviceBoxAdapter.Bodies.length, {u: 1, v: 6})}
                                  {dragControl(spread, {u: 0, v: 8})}
                                  {dragControl(volume, {u: 1, v: 8})}
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
