import css from "./SurgeonDeviceEditor.sass?inline"
import {Arrays, clamp, DefaultObservableValue, int, isDefined, Lifecycle, Option, Optional, Procedure, ValueGuide} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Box, Propagation} from "@opendaw/lib-box"
import {
    AutomatableParameterFieldAdapter,
    DeviceHost,
    InstrumentFactories,
    Surgeon,
    SurgeonDeviceBoxAdapter,
    SurgeonModel,
    TrackType
} from "@opendaw/studio-adapters"
import {CanvasPainter, ContextMenu, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"
import {GrooveMenus} from "@/ui/grooves/GrooveMenus"

const className = Html.adoptStyleSheet(css, "SurgeonDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SurgeonDeviceBoxAdapter
    deviceHost: DeviceHost
}

const NoSlot = -2
const LaneColors = [Colors.blue, Colors.green, Colors.yellow, Colors.orange]
const ToneParams: ReadonlyArray<int> = [0, 1, 2, 3, 4, 5, 6, 7]
const ShapeParams: ReadonlyArray<int> = [8, 9, 10, 11, 12, 13, 14, 15]
const SoundKeys: ReadonlyArray<int> = [...Surgeon.Sound, ...Surgeon.Amounts.flat()].map(({key}) => key)
const PixelsPerStep = 6
// shared by every Surgeon editor: the tab and a copied pattern survive a rebuilt editor
const selectedTab = new DefaultObservableValue<int>(0)
const clipboard: { pattern: Optional<SurgeonModel.Pattern>, groove: Option<Box> } = {pattern: undefined, groove: Option.None}

export const SurgeonDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver, engine} = project
    const {box, namedParameter} = adapter
    const {Lanes, PatternCount, Off, LaneNames} = Surgeon
    const rollSeed = (): int => Math.floor(Math.random() * 100_000)
    const act = (action: Procedure<void>): void => {
        editing.mark()
        editing.modify(action)
    }
    const laneColor = (index: int): string => LaneColors[index].toString()
    const dragging = (parameter: AutomatableParameterFieldAdapter<number>, options?: ValueGuide.Options) => (
        <AutomationControl lifecycle={lifecycle}
                           editing={editing}
                           midiLearning={midiLearning}
                           tracks={adapter.deviceHost().audioUnitBoxAdapter().tracks}
                           parameter={parameter}>
            <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={parameter} supressValueFlyout={true}
                                       options={options}>
                <ParameterLabel lifecycle={lifecycle} parameter={parameter} classList={["center"]} framed={true}/>
            </RelativeUnitValueDragging>
        </AutomationControl>
    )
    const control = (caption: string, parameter: AutomatableParameterFieldAdapter<number>, gridArea?: string, color?: string) => (
        <div className="control" style={isDefined(gridArea) ? {gridArea} : {}}>
            <h3 style={isDefined(color) ? {color} : {}}>{caption}</h3>
            {dragging(parameter)}
        </div>
    )
    const live = ({key}: Surgeon.Spec) => adapter.live(key)
    // a whole step every few pixels: the default track would pass several steps per pixel over 257 values
    const inline = (caption: string, parameter: AutomatableParameterFieldAdapter<number>, values: int) => (
        <div className="inline">
            <h3>{caption}</h3>
            {dragging(parameter, {trackLength: values * PixelsPerStep})}
        </div>
    )
    const button = (label: string, action: Procedure<void>, gridArea: string, group: string): HTMLElement => {
        const element: HTMLElement = <div className={`button ${group}`} style={{gridArea}}>{label}</div>
        lifecycle.own(Events.subscribe(element, "click", () => action()))
        return element
    }
    const presses = (element: HTMLElement, others: ReadonlyArray<HTMLElement>): HTMLElement => {
        const press = (pressed: boolean) => () => others.forEach(other => other.classList.toggle("pressed", pressed))
        lifecycle.ownAll(
            Events.subscribe(element, "pointerdown", press(true)),
            Events.subscribe(element, "pointerup", press(false)),
            Events.subscribe(element, "pointerleave", press(false)),
            Events.subscribe(element, "pointercancel", press(false)))
        return element
    }
    const state: { active: int, fired: int, reported: boolean } = {active: box.slot.getValue(), fired: NoSlot, reported: false}
    const tiles: ReadonlyArray<HTMLElement> = Arrays.create(index => <div className="tile">{String(index + 1)}</div>, PatternCount)
    const offTile: HTMLElement = <div className="tile off">Off</div>
    const updateTiles = () => {
        const playing = engine.isPlaying.getValue() && state.reported
        const active = playing ? state.active : box.slot.getValue()
        const fired = playing ? state.fired : NoSlot
        tiles.forEach((tile, index) => {
            tile.classList.toggle("active", active === index)
            tile.classList.toggle("fired", fired === index)
        })
        offTile.classList.toggle("active", active === Off)
        offTile.classList.toggle("fired", fired === Off)
    }
    const slotItems = (): ReadonlyArray<MenuItem> => {
        const tracks = adapter.deviceHost().audioUnitBoxAdapter().tracks
        const {slot} = namedParameter
        return [tracks.controls(slot.field).isEmpty()
            ? MenuItem.default({label: "Create Automation"}).setTriggerProcedure(() => editing.modify(() => {
                if (slot.track.isEmpty()) {tracks.create(TrackType.Value, slot.field)}
            }))
            : MenuItem.default({label: "Remove Automation"}).setTriggerProcedure(() => editing.modify(() =>
                slot.track.ifSome(track => tracks.delete(track))))]
    }
    tiles.forEach((tile, index) => lifecycle.ownAll(
        Events.subscribe(tile, "click", () => act(() => adapter.select(index))),
        ContextMenu.subscribe(tile, collector => collector.addItems(
            ...slotItems(),
            MenuItem.default({label: "Copy pattern", separatorBefore: true}).setTriggerProcedure(() => {
                clipboard.pattern = adapter.patternModel(index)
                clipboard.groove = box.patterns.fields()[index].groove.targetVertex.map(({box: groove}) => groove)
            }),
            MenuItem.default({label: "Paste pattern", selectable: isDefined(clipboard.pattern)}).setTriggerProcedure(() => {
                const {pattern, groove} = clipboard
                if (!isDefined(pattern)) {return}
                act(() => {
                    adapter.writePattern(index, pattern)
                    const pointer = box.patterns.fields()[index].groove
                    groove.flatMap(source => source.graph === box.graph && source.isAttached() ? Option.wrap(source) : Option.None)
                        .match({none: () => pointer.defer(), some: source => pointer.refer(source)})
                })
            })))))
    lifecycle.ownAll(
        Events.subscribe(offTile, "click", () => act(() => adapter.select(Off))),
        ContextMenu.subscribe(offTile, collector => collector.addItems(...slotItems())))
    const canvas: HTMLCanvasElement = <canvas/>
    const painted = {step: -1, fontFamily: ""}
    const stepPulses = (): number =>
        SurgeonModel.RatePulses[clamp(adapter.live(Surgeon.Rate.key).getValue(), 0, SurgeonModel.RatePulses.length - 1)]
    const playingStep = (): int => Math.max(0, Math.floor(engine.position.getValue() / stepPulses()))
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight, devicePixelRatio}) => {
        const pattern = adapter.liveModel()
        const playing = engine.isPlaying.getValue()
        const sounding = box.slot.getValue() !== Off
        const position = playingStep()
        painted.step = position
        if (painted.fontFamily === "") {painted.fontFamily = getComputedStyle(canvas).fontFamily}
        const thickness = devicePixelRatio * 4
        const pitchBottom = actualHeight * 0.5
        const middle = pitchBottom / 2
        const reach = middle - thickness / 2
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.globalAlpha = sounding ? 1.0 : 0.35
        context.strokeStyle = DisplayPaint.gridStyle(0.3)
        context.lineWidth = devicePixelRatio
        context.setLineDash([2 * devicePixelRatio, 3 * devicePixelRatio])
        context.beginPath()
        context.moveTo(0, middle)
        context.lineTo(actualWidth, middle)
        context.stroke()
        context.setLineDash([])
        const {pitch, lanes} = pattern
        const phase = SurgeonModel.phase(pattern, position)
        const {position: read, passes} = phase.unwrapOrElse({position: 0, passes: Arrays.create(() => 0, lanes.length + 1)})
        const shown = playing && sounding && phase.nonEmpty()
        const steps = clamp(pitch.steps, 1, SurgeonModel.MaxSteps)
        const pass = passes[0]
        const width = actualWidth / steps
        for (let index = 0; index < steps; index++) {
            const {offset, kind, slide} = SurgeonModel.stepAt(pitch, index, pass)
            const current = shown && index === read % steps
            const x = index * width
            if (kind === SurgeonModel.Kind.Rest) {
                context.fillStyle = DisplayPaint.gridStyle(current ? 0.6 : 0.25)
                context.fillRect(x + devicePixelRatio, middle - devicePixelRatio, width - devicePixelRatio * 2, devicePixelRatio * 2)
                continue
            }
            const y = middle - offset / Math.max(pitch.range, 1.0) * reach
            if (slide && (index > 0 || pass > 0)) {
                const from = index > 0 ? SurgeonModel.stepAt(pitch, index - 1, pass) : SurgeonModel.stepAt(pitch, steps - 1, pass - 1)
                if (from.kind !== SurgeonModel.Kind.Rest) {
                    context.strokeStyle = DisplayPaint.strokeStyle(0.5)
                    context.beginPath()
                    context.moveTo(x - width * 0.5, middle - from.offset / Math.max(pitch.range, 1.0) * reach)
                    context.lineTo(x + devicePixelRatio, y)
                    context.stroke()
                }
            }
            context.fillStyle = current ? Colors.white.toString() : DisplayPaint.strokeStyle(0.8)
            context.beginPath()
            context.roundRect(x + devicePixelRatio, y - thickness / 2,
                (width - devicePixelRatio * 2) * (kind === SurgeonModel.Kind.Tie ? 1.0 : 0.5), thickness, thickness / 2)
            context.fill()
        }
        const laneHeight = (actualHeight - pitchBottom) / Surgeon.LaneCount
        const letter = devicePixelRatio * 12
        context.font = `${8 * devicePixelRatio}px ${painted.fontFamily}`
        context.textBaseline = "middle"
        lanes.forEach((lane, laneIndex) => {
            const top = pitchBottom + laneIndex * laneHeight
            const count = clamp(lane.steps, 1, SurgeonModel.MaxSteps)
            const barWidth = (actualWidth - letter) / count
            const height = laneHeight - devicePixelRatio * 3
            context.fillStyle = LaneColors[laneIndex].toString()
            context.fillText(LaneNames[laneIndex], 0, top + (laneHeight + devicePixelRatio * 3) / 2)
            for (let index = 0; index < count; index++) {
                const amount = SurgeonModel.laneValueAt(lane, index, passes[laneIndex + 1])
                const current = shown && index === read % count
                const filled = Math.max(devicePixelRatio, amount * height)
                context.fillStyle = current ? Colors.white.toString() : LaneColors[laneIndex].opacity(0.75).toString()
                context.fillRect(letter + index * barWidth, top + laneHeight - filled,
                    Math.max(devicePixelRatio, index === count - 1 ? barWidth : barWidth - devicePixelRatio), filled)
            }
        })
        context.globalAlpha = 1.0
    }))
    lifecycle.ownAll(
        box.subscribe(Propagation.Children, painter.requestUpdate),
        box.slot.subscribe(updateTiles),
        engine.isPlaying.subscribe(() => {
            state.reported = false
            updateTiles()
            painter.requestUpdate()
        }),
        liveStreamReceiver.subscribeIntegers(adapter.state, ([active, fired]) => {
            if (state.reported && active === state.active && fired === state.fired) {return}
            state.active = active
            state.fired = fired
            state.reported = true
            updateTiles()
        }),
        AnimationFrame.add(() => {if (engine.isPlaying.getValue() && playingStep() !== painted.step) {painter.requestUpdate()}})
    )
    const rollModel = (keys: ReadonlyArray<int>, change: Procedure<SurgeonModel.Pattern>) => () => act(() => {
        const model = adapter.liveModel()
        change(model)
        adapter.writeLiveKeys(model, keys)
    })
    const laneRolls: ReadonlyArray<HTMLElement> = Arrays.create(index => button("Roll",
        rollModel([Lanes[index][1].key], model => model.lanes[index].seed = rollSeed()), `3 / ${index * 2 + 2}`, "lanes"), Surgeon.LaneCount)
    const laneControls = Arrays.create(index => {
        const column = 1 + index * 2
        const [steps, seed, mutate] = Lanes[index]
        return [
            control(`${LaneNames[index]} Steps`, live(steps), `2 / ${column}`, laneColor(index)),
            control("Seed", live(seed), `2 / ${column + 1}`),
            control("Mutate", live(mutate), `3 / ${column}`),
            laneRolls[index]
        ]
    }, Surgeon.LaneCount)
    const rollPitch = button("Pitch", rollModel([3], model => model.pitch.seed = rollSeed()), "4 / 1 / 5 / 3", "roll")
    const rollLanes = presses(button("Lanes", rollModel(Lanes.map(([, seed]) => seed.key),
        model => model.lanes.forEach(lane => lane.seed = rollSeed())), "4 / 3 / 5 / 5", "roll"), laneRolls)
    const rollSound = button("Sound", rollModel(SoundKeys, model => {
        const {base, amounts} = SurgeonModel.random(rollSeed())
        base.forEach((position, index) => model.base[index] = position)
        amounts.forEach((row, index) => model.amounts[index] = row)
    }), "4 / 5 / 5 / 7", "roll")
    const rollAll = presses(button("All", () => act(() =>
            adapter.writeLive(SurgeonModel.rollAll(adapter.liveModel(), rollSeed()))), "4 / 7 / 5 / 9", "roll"),
        [rollPitch, rollLanes, rollSound, ...laneRolls])
    const loops: HTMLElement = (
        <section className="loops">
            <div className="band pitch" style={{gridArea: "1 / 1 / 2 / -1"}}/>
            <div className="band lanes" style={{gridArea: "2 / 1 / 4 / -1"}}/>
            <div className="band roll" style={{gridArea: "4 / 1 / 5 / -1"}}/>
            <h3 className="rotated pitch" style={{gridArea: "1 / -2"}}>PITCH</h3>
            {Surgeon.Pitch.map((spec, index) => control(spec.name, live(spec), `1 / ${index + 1}`))}
            <h3 className="rotated lanes" style={{gridArea: "2 / -2 / 4 / -1"}}>LANES</h3>
            {laneControls}
            <h3 className="rotated roll" style={{gridArea: "4 / -2"}}>ROLL</h3>
            {rollPitch}
            {rollLanes}
            {rollSound}
            {rollAll}
        </section>
    )
    const amountCell = (param: int, lane: int): HTMLElement => {
        const parameter = live(Surgeon.Amounts[param][lane])
        const cell: HTMLElement = (
            <div className="cell amount" style={{gridArea: `${lane + 3} / ${ToneParams.includes(param) ? param + 1 : param - 7}`, "--color": laneColor(lane)}}>
                {dragging(parameter)}
            </div>
        )
        lifecycle.own(parameter.catchupAndSubscribe(owner =>
            cell.classList.toggle("zero", Math.round(owner.getValue() * 100) === 0)))
        return cell
    }
    const sound = (params: ReadonlyArray<int>): HTMLElement => (
        <section className="sound">
            {params.map((param, index) => <h3 className="caption" style={{gridArea: `1 / ${index + 1}`}}>{Surgeon.Sound[param].name}</h3>)}
            <div className="band base" style={{gridArea: "2 / 1 / 3 / -1"}}/>
            <h3 className="rotated base" style={{gridArea: "2 / -2"}}>0</h3>
            {params.map((param, index) => <div className="cell" style={{gridArea: `2 / ${index + 1}`}}>{dragging(live(Surgeon.Sound[param]))}</div>)}
            {Arrays.create(lane => [
                <div className="band" style={{gridArea: `${lane + 3} / 1 / ${lane + 4} / -1`, "--color": laneColor(lane)}}/>,
                <h3 className="rotated" style={{gridArea: `${lane + 3} / -2`, "--color": laneColor(lane)}}>{LaneNames[lane]}</h3>,
                params.map(param => amountCell(param, lane))
            ], Surgeon.LaneCount)}
        </section>
    )
    const sections: ReadonlyArray<HTMLElement> = [loops, sound(ToneParams), sound(ShapeParams)]
    const tabs: ReadonlyArray<HTMLElement> = ["LOOPS", "TONE", "SHAPE"].map(label => <h3 className="tab">{label}</h3>)
    tabs.forEach((tab, index) => lifecycle.own(Events.subscribe(tab, "click", () => selectedTab.setValue(index))))
    const selectedGroove = () => box.patterns.fields()[box.pattern.getValue()].groove
    const grooveButton: HTMLElement = (
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
            GrooveMenus.choiceItems(project, [selectedGroove()])(parent))}
                    appearance={{tooltip: () => GrooveMenus.tooltip(project, selectedGroove())()}}>
            <label>Groove<Icon symbol={IconSymbol.Dropdown}/></label>
        </MenuButton>
    )
    const grooveIndicator: HTMLElement = <div className="indicator"/>
    const updateGroove = () => grooveIndicator.classList.toggle("set", selectedGroove().nonEmpty())
    lifecycle.ownAll(box.pattern.subscribe(updateGroove),
        ...box.patterns.fields().map(pattern => pattern.groove.subscribe(updateGroove)))
    updateGroove()
    lifecycle.own(selectedTab.catchupAndSubscribe(owner => {
        tabs.forEach((tab, index) => tab.classList.toggle("selected", index === owner.getValue()))
        sections.forEach((section, index) => section.classList.toggle("hidden", index !== owner.getValue()))
    }))
    updateTiles()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forAudioUnitInput(parent, service, deviceHost)}
                      populateControls={() => (
                          <div className={className}>
                              <nav className="patterns">
                                  <div className="circles">
                                      {tiles}
                                      {offTile}
                                  </div>
                                  <div className="values">
                                      {control("Rate", live(Surgeon.Rate))}
                                      {control("Tune", namedParameter.tune)}
                                      {control("Volume", namedParameter.volume)}
                                  </div>
                              </nav>
                              <div className="display">
                                  <div className="groove">
                                      {grooveIndicator}{grooveButton}
                                      {inline("Restart", live(Surgeon.Restart), SurgeonModel.MaxRestart + 1)}
                                      {inline("Offset", live(Surgeon.Offset), SurgeonModel.MaxOffset * 2 + 1)}
                                  </div>
                                  {canvas}
                              </div>
                              <div className="sections">
                                  <header>{tabs}</header>
                                  {sections}
                              </div>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={InstrumentFactories.Surgeon.defaultIcon}/>
    )
}
