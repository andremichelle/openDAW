import css from "./EuclidDeviceEditor.sass?inline"
import {
    Arrays, asInstanceOf, Color, int, isDefined, Lifecycle, Mulberry32, Notifier, Option, Optional, Procedure, Subscription, Terminator,
    tryCatch
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {deferNextFrame, Events, Html} from "@opendaw/lib-dom"
import {Float32Field, Int32Field} from "@opendaw/lib-box"
import {MidiKeys} from "@opendaw/lib-dsp"
import {
    AudioBusBoxAdapter, AutomatableParameterFieldAdapter, DeviceHost, Euclid, EuclidDeviceBoxAdapter, TrackType
} from "@opendaw/studio-adapters"
import {EuclidLaneBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {CanvasPainter, ClipboardEntry, ClipboardManager, ContextMenu, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DeviceMidiMeter} from "@/ui/devices/panel/DeviceMidiMeter.tsx"
import {StudioService} from "@/service/StudioService"
import {AutomationControl} from "@/ui/components/AutomationControl"
import {RelativeUnitValueDragging} from "@/ui/wrapper/RelativeUnitValueDragging"
import {ParameterLabel} from "@/ui/components/ParameterLabel"
import {MenuButton} from "@/ui/components/MenuButton"
import {GrooveMenus} from "@/ui/grooves/GrooveMenus"
import {SamplerValueLabel} from "@/ui/devices/instruments/SamplerDeviceEditor/SamplerValueLabel"
import {EuclidRhythm} from "@/ui/devices/midi-effects/Euclid/EuclidRhythm"
import {EuclidCircle} from "@/ui/devices/midi-effects/Euclid/EuclidCircle"
import {EuclidNotes} from "@/ui/devices/midi-effects/Euclid/EuclidNotes"

const className = Html.adoptStyleSheet(css, "EuclidDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: EuclidDeviceBoxAdapter
    deviceHost: DeviceHost
}

const PatternEntry = "euclid-pattern"
// a copied pattern: the rhythm values of every lane in list order and the groove by uuid
type CopiedPattern = { readonly rhythms: ReadonlyArray<ReadonlyArray<number>>, readonly groove: Optional<string> }
const RhythmKeys: ReadonlyArray<keyof Euclid.Rhythm> =
    ["steps", "pulses", "rotate", "rate", "accents", "accentRotate", "bursts", "burstRotate", "repeats", "fade"]

export const EuclidDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, liveStreamReceiver, engine, boxGraph} = project
    const {box, namedParameter} = adapter
    const changed = lifecycle.own(new Notifier<void>())
    const observe = (observer: Procedure<void>): Subscription => changed.subscribe(observer)
    const schedule = lifecycle.own(deferNextFrame(() => changed.notify()))
    lifecycle.own(boxGraph.subscribeToAllUpdates({onUpdate: () => schedule.request()}))
    let selected: int = 0
    let edited: int = Math.max(0, box.pattern.getValue())
    lifecycle.own(box.pattern.subscribe(owner => {
        if (owner.getValue() >= 0) {edited = owner.getValue()}
        schedule.request()
    }))
    const lanes = (): ReadonlyArray<EuclidLaneBox> => Euclid.lanesOf(box)
    const lane = (): Option<EuclidLaneBox> => {
        const all = lanes()
        return Option.wrap(all[Math.min(selected, all.length - 1)])
    }
    const rhythm = (): Option<Euclid.Rhythm> => lane().map(each => Euclid.rhythmOf(each, edited))
    const noteName = (note: int): Option<string> => deviceHost.audioUnitBoxAdapter().inputAdapter.flatMap(input =>
        input instanceof AudioBusBoxAdapter || !isDefined(input.noteName) ? Option.None : input.noteName(note))
    const labelOf = (note: int): string => noteName(note).unwrapOrElse(() => MidiKeys.toFullString(note))
    const area = (column: int, row: int): string => `${row * 2 + 2} / ${column} / ${row * 2 + 4} / ${column + 1}`
    const head = (title: string, color: Color, column: int, span: int): Array<HTMLElement> => [
        <section style={{gridArea: `1 / ${column} / -1 / ${column + span}`, "--color": color.toString()}}/>,
        <h3 className="head" style={{gridArea: `1 / ${column} / 2 / ${column + span}`, "--color": color.toString()}}>
            {title}
        </h3>
    ]
    const control = (caption: string, child: HTMLElement, gridArea: string): HTMLElement => (
        <div className="control" style={{gridArea}}>
            <h3>{caption}</h3>
            {child}
        </div>
    )
    const parameter = (caption: string, field: AutomatableParameterFieldAdapter<number>, gridArea: string): HTMLElement =>
        control(caption, (
            <AutomationControl lifecycle={lifecycle} editing={editing} midiLearning={midiLearning}
                               tracks={deviceHost.audioUnitBoxAdapter().tracks} parameter={field}>
                <RelativeUnitValueDragging lifecycle={lifecycle} editing={editing} parameter={field} supressValueFlyout={true}>
                    <ParameterLabel lifecycle={lifecycle} parameter={field} classList={["center"]} framed={true}/>
                </RelativeUnitValueDragging>
            </AutomationControl>
        ), gridArea)
    const {numberIn} = SamplerValueLabel
    const value = (min: number, max: number, step: number, print: (value: number) => SamplerValueLabel.Printed,
                   get: () => number, set: (value: number) => void, parse = numberIn): HTMLElement =>
        SamplerValueLabel.create(lifecycle, editing, observe, {
            name: "", min, max, step, print, parse, get, set, available: () => lane().nonEmpty()
        })
    const integer = (print: (value: number) => string = String) => (value: number): SamplerValueLabel.Printed =>
        [print(Math.round(value)), ""]
    const percent = (value: number): SamplerValueLabel.Printed => [String(Math.round(value * 100)), "%"]
    const fromPercent = (text: string): Optional<number> => {
        const parsed = numberIn(text)
        return isDefined(parsed) ? parsed / 100 : undefined
    }
    // a lane's rhythm value in the edited pattern
    const rhythmValue = (pick: (rhythm: Euclid.Rhythm) => Int32Field, min: int, max: int): HTMLElement =>
        value(min, max, 1, integer(), () => rhythm().mapOr(each => pick(each).getValue(), 0),
            next => rhythm().ifSome(each => pick(each).setValue(Math.round(next))))
    const laneValue = (pick: (lane: EuclidLaneBox) => Float32Field, min: number): HTMLElement =>
        value(min, 1, 0.01, percent, () => lane().mapOr(each => pick(each).getValue(), 0),
            next => lane().ifSome(each => pick(each).setValue(next)), fromPercent)
    const choice = (names: ReadonlyArray<string>, field: () => Option<Int32Field>): HTMLElement =>
        SamplerValueLabel.choice(lifecycle, observe, {
            names, get: () => field().mapOr(each => each.getValue(), 0),
            set: index => editing.modify(() => field().ifSome(each => each.setValue(index))),
            available: () => lane().nonEmpty()
        })
    const noteMenu = (): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        lifecycle.own(observe(() => label.textContent = lane().mapOr(each => labelOf(each.note.getValue()), "–")))
        const noteItem = (note: int): MenuItem => MenuItem.default({
            label: noteName(note).mapOr(name => `${MidiKeys.toFullString(note)}  ${name}`, MidiKeys.toFullString(note)),
            checked: lane().mapOr(each => each.note.getValue() === note, false)
        }).setTriggerProcedure(() => editing.modify(() => lane().ifSome(each => each.note.setValue(note))))
        const octaveItem = (octave: int): MenuItem => MenuItem.default({
            label: `${MidiKeys.toFullString(octave * 12)} to ${MidiKeys.toFullString(Math.min(127, octave * 12 + 11))}`,
            checked: lane().mapOr(each => Math.floor(each.note.getValue() / 12) === octave, false)
        }).setRuntimeChildrenProcedure(sub => Arrays.create(index => octave * 12 + index, 12)
            .filter(note => note < 128)
            .forEach(note => sub.addMenuItem(noteItem(note))))
        const root = MenuItem.root().setRuntimeChildrenProcedure(parent =>
            Arrays.create(octave => octave, 11).forEach(octave => parent.addMenuItem(octaveItem(octave))))
        return <MenuButton root={root} appearance={{color: Colors.gray, activeColor: Colors.bright}}>{label}</MenuButton>
    }
    // the step a lane plays at the transport position, -1 while stopped or off
    const stepOf = (each: EuclidLaneBox): int => {
        if (!engine.isPlaying.getValue() || box.pattern.getValue() < 0) {return -1}
        const {steps, rate} = Euclid.rhythmOf(each, edited)
        const factor = Euclid.GlobalFactors[namedParameter.rate.getValue()] ?? 1
        const duration = (Euclid.ValueQuarters[rate.getValue()] ?? 0.25) * 960 / factor
        const length = namedParameter.length.getValue()
        const position = Math.max(0, engine.position.getValue())
        const local = length > 0 ? position % (length * 240 / factor) : position
        return Math.floor(local / duration) % Math.max(1, steps.getValue())
    }
    const stepsOf = (each: EuclidLaneBox): ReadonlyArray<EuclidRhythm.Step> => {
        const rhythm = Euclid.rhythmOf(each, edited)
        return EuclidRhythm.steps({
            steps: rhythm.steps.getValue(), pulses: rhythm.pulses.getValue(), rotate: rhythm.rotate.getValue(),
            accents: rhythm.accents.getValue(), accentRotate: rhythm.accentRotate.getValue(),
            bursts: rhythm.bursts.getValue(), burstRotate: rhythm.burstRotate.getValue()
        })
    }
    const audible = (each: EuclidLaneBox): boolean =>
        !each.mute.getValue() && (each.solo.getValue() || !lanes().some(other => other.solo.getValue()))
    // the dot is lit while the lane's note sounds: one step long, or until the next hit
    const sounding = (each: EuclidLaneBox): boolean => {
        const step = stepOf(each)
        if (step < 0 || !audible(each)) {return false}
        const steps = stepsOf(each)
        return each.gate.getValue() === 0 ? steps[step]?.hit === true : steps.some(entry => entry.hit)
    }
    const list: HTMLElement = <div className="lanes"/>
    const rows = lifecycle.own(new Terminator())
    let rowElements: ReadonlyArray<HTMLElement> = []
    let dots: ReadonlyArray<readonly [EuclidLaneBox, HTMLElement]> = []
    let dragging: Option<int> = Option.None
    const renderList = (): void => {
        rows.terminate()
        const all = lanes()
        const rendered = all.map((each, index) => {
            const toggle = (label: string, active: boolean, flip: () => void): HTMLElement => {
                const element: HTMLElement = <span className={Html.buildClassList("toggle", label === "S" && "solo", active && "active")}>
                    {label}
                </span>
                rows.own(Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
                    event.stopPropagation()
                    editing.modify(flip)
                }))
                return element
            }
            const dot: HTMLElement = <span className="dot"/>
            const note = each.note.getValue()
            const row: HTMLElement = (
                <div className={Html.buildClassList("lane", index === Math.min(selected, all.length - 1) && "selected",
                    !audible(each) && "silent")}>
                    <span className="note">{MidiKeys.toFullString(note)}</span>
                    {dot}
                    <span className="name">{noteName(note).unwrapOrElse("")}</span>
                    {toggle("M", each.mute.getValue(), () => each.mute.setValue(!each.mute.getValue()))}
                    {toggle("S", each.solo.getValue(), () => each.solo.setValue(!each.solo.getValue()))}
                </div>
            )
            rows.ownAll(
                Events.subscribe(row, "pointerdown", (event: PointerEvent) => {
                    selected = index
                    dragging = Option.wrap(index)
                    list.setPointerCapture(event.pointerId)
                    changed.notify()
                }),
                ContextMenu.subscribe(row, collector => collector.addItems(
                    MenuItem.default({label: "Remove lane", selectable: all.length > 1})
                        .setTriggerProcedure(() => editing.modify(() => Euclid.removeLane(box, each)))))
            )
            return [row, [each, dot] as const] as const
        })
        rowElements = rendered.map(([row]) => row)
        dots = rendered.map(([, dot]) => dot)
        list.replaceChildren(...rowElements)
    }
    // a pressed lane follows the pointer up and down the list
    lifecycle.ownAll(
        Events.subscribe(list, "pointermove", (event: PointerEvent) => dragging.ifSome(from => {
            const top = list.getBoundingClientRect().top - list.scrollTop
            const above = rowElements.filter(row => row.offsetTop <= event.clientY - top).length
            const to = Math.max(0, Math.min(lanes().length - 1, above - 1))
            if (to === from) {return}
            editing.modify(() => Euclid.moveLane(box, from, to))
            selected = to
            dragging = Option.wrap(to)
        })),
        Events.subscribe(list, "pointerup", () => dragging = Option.None),
        Events.subscribe(list, "pointercancel", () => dragging = Option.None)
    )
    const roll = (all: boolean): void => {editing.modify(() => {
        const seed = box.seed.getValue()
        box.seed.setValue(seed + 1)
        const random = new Mulberry32(seed)
        const targets = all ? lanes() : lane().mapOr(each => [each], [])
        targets.forEach(each => {
            const {steps, pulses, rotate, accents, accentRotate} = Euclid.rhythmOf(each, edited)
            const length = [8, 12, 16, 16, 16, 24, 32][random.nextInt(0, 7)]
            const hits = random.nextInt(1, Math.ceil(length * 0.75) + 1)
            steps.setValue(length)
            pulses.setValue(hits)
            rotate.setValue(random.nextInt(0, length))
            accents.setValue(random.nextInt(0, hits + 1))
            accentRotate.setValue(random.nextInt(0, hits))
        })
    })}
    const button = (label: string, action: () => void): HTMLElement => {
        const element: HTMLElement = <div className="button">{label}</div>
        lifecycle.own(Events.subscribe(element, "click", action))
        return element
    }
    const addLane = (): void => {editing.modify(() => {
        if (lanes().length >= Euclid.MaxLanes) {return}
        const used = new Set(lanes().map(each => each.note.getValue()))
        const start = lane().mapOr(each => each.note.getValue(), 60)
        const note = Arrays.create(index => (start + index) % 128, 128).find(candidate => !used.has(candidate)) ?? start
        Euclid.createLane(boxGraph, box, note)
        selected = lanes().length - 1
    })}
    // the clipboard carries a pattern: the rhythm of every lane in list order and its groove
    const copyPattern = (pattern: int): ClipboardEntry => {
        const rhythms = lanes().map(each => {
            const rhythm = Euclid.rhythmOf(each, pattern)
            return RhythmKeys.map(key => rhythm[key].getValue())
        })
        const groove = box.patterns.fields()[pattern].groove.targetVertex.mapOr(({box: target}) => target.address.toString(), undefined)
        const copied: CopiedPattern = {rhythms, groove}
        return {type: PatternEntry, data: new TextEncoder().encode(JSON.stringify(copied)).buffer, count: 1}
    }
    const pastePattern = (pattern: int, entry: ClipboardEntry): void => {
        if (entry.type !== PatternEntry) {return}
        const {status, value: copied} = tryCatch(() => JSON.parse(new TextDecoder().decode(entry.data)) as CopiedPattern)
        if (status !== "success") {return}
        editing.modify(() => {
            lanes().forEach((each, index) => {
                const values = copied.rhythms[index]
                if (!isDefined(values)) {return}
                const rhythm = Euclid.rhythmOf(each, pattern)
                RhythmKeys.forEach((key, at) => rhythm[key].setValue(values[at]))
            })
            const pointer = box.patterns.fields()[pattern].groove
            const groove = project.rootBoxAdapter.grooves.adapters().find(each => each.box.address.toString() === copied.groove)
            if (isDefined(groove)) {pointer.refer(groove.box)} else {pointer.defer()}
        })
    }
    // a pattern written into a note region at the playhead: Length steps, or one bar when the lanes never restart
    const exportPattern = (pattern: int): void => {
        const {api} = project
        const track = deviceHost.audioUnitBoxAdapter().tracks.collection.adapters().find(each => each.type === TrackType.Notes)
        if (!isDefined(track)) {return}
        const factor = Euclid.GlobalFactors[namedParameter.rate.getValue()] ?? 1
        const length = namedParameter.length.getValue()
        const period = length > 0 ? length * 240 / factor : Infinity
        const duration = length > 0 ? period : 3840
        const notes = EuclidNotes.of(lanes().map(each => {
            const rhythm = Euclid.rhythmOf(each, pattern)
            return {
                note: each.note.getValue(), velocity: each.velocity.getValue(), gate: each.gate.getValue(), audible: audible(each),
                steps: EuclidRhythm.steps({
                    steps: rhythm.steps.getValue(), pulses: rhythm.pulses.getValue(), rotate: rhythm.rotate.getValue(),
                    accents: rhythm.accents.getValue(), accentRotate: rhythm.accentRotate.getValue(),
                    bursts: rhythm.bursts.getValue(), burstRotate: rhythm.burstRotate.getValue()
                }),
                step: (Euclid.ValueQuarters[rhythm.rate.getValue()] ?? 0.25) * 960 / factor,
                repeats: rhythm.repeats.getValue(), fade: rhythm.fade.getValue()
            }
        }), duration, period)
        editing.modify(() => api.createTrackRegion(track.box, Math.max(0, service.timeline.snapping.floor(engine.position.getValue())),
            duration, {name: `Euclid ${pattern + 1}`}).ifSome(region => notes.forEach(({position, duration, pitch, velocity}) =>
            api.createNoteEvent({owner: asInstanceOf(region, NoteRegionBox), position, duration, pitch, velocity}))))
    }
    const tiles: HTMLElement = <div className="tiles" style={{gridArea: "2 / 1 / 6 / 3"}}/>
    const tileElements = Arrays.create(index => {
        const off = index === Euclid.Patterns
        const pattern = off ? Euclid.Off : index
        const tile: HTMLElement = <div className={Html.buildClassList("tile", off && "off")} tabIndex={-1}>
            {off ? "Off" : String(index + 1)}
        </div>
        lifecycle.ownAll(
            Events.subscribe(tile, "pointerdown", () => tile.focus()),
            Events.subscribe(tile, "click", () => {
                if (!off) {edited = index}
                editing.modify(() => box.pattern.setValue(pattern))
            }),
            ContextMenu.subscribe(tile, collector => {
                if (off) {return}
                collector.addItems(
                    MenuItem.default({label: "Copy pattern"}).setTriggerProcedure(() => ClipboardManager.write(copyPattern(index))),
                    MenuItem.default({label: "Paste pattern",
                        selectable: ClipboardManager.peek().mapOr(entry => entry.type === PatternEntry, false)})
                        .setTriggerProcedure(() => ClipboardManager.peek().ifSome(entry => pastePattern(index, entry))),
                    MenuItem.default({label: "Export to Note Region", separatorBefore: true})
                        .setTriggerProcedure(() => exportPattern(index)))
            })
        )
        return tile
    }, Euclid.Patterns + 1)
    tiles.append(...tileElements)
    const focusedPattern = (): Option<int> => {
        const index = tileElements.findIndex(tile => tile === document.activeElement)
        return index >= 0 && index < Euclid.Patterns ? Option.wrap(index) : Option.None
    }
    lifecycle.own(ClipboardManager.install(tiles, {
        canCopy: () => focusedPattern().nonEmpty(),
        canCut: () => false,
        canPaste: (entry: ClipboardEntry) => entry.type === PatternEntry && focusedPattern().nonEmpty(),
        copy: () => focusedPattern().map(copyPattern),
        cut: () => Option.None,
        paste: (entry: ClipboardEntry) => focusedPattern().ifSome(index => pastePattern(index, entry))
    }))
    // the engine reports the playing and the waiting pattern while the transport runs
    const reported = {active: box.pattern.getValue(), waiting: Euclid.NoPattern, fresh: false}
    lifecycle.ownAll(
        liveStreamReceiver.subscribeIntegers(adapter.state, ([active, waiting]) => {
            if (reported.fresh && reported.active === active && reported.waiting === waiting) {return}
            reported.active = active
            reported.waiting = waiting
            reported.fresh = true
            changed.notify()
        }),
        engine.isPlaying.subscribe(() => {
            reported.fresh = false
            changed.notify()
        })
    )
    const updateTiles = (): void => {
        const playing = engine.isPlaying.getValue() && reported.fresh
        const active = playing ? reported.active : box.pattern.getValue()
        const waiting = playing ? reported.waiting : Euclid.NoPattern
        tileElements.forEach((tile, index) => {
            const pattern = index === Euclid.Patterns ? Euclid.Off : index
            tile.classList.toggle("active", active === pattern)
            tile.classList.toggle("fired", waiting === pattern)
            tile.classList.toggle("edited", pattern === edited && active !== pattern)
        })
    }
    const grooveLabel: HTMLElement = <label className="value"/>
    const grooveButton: HTMLElement = (
        <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
            GrooveMenus.choiceItems(project, [box.patterns.fields()[edited].groove])(parent))}
                    appearance={{color: Colors.gray, activeColor: Colors.bright}}>{grooveLabel}</MenuButton>
    )
    const canvas: HTMLCanvasElement = <canvas/>
    let playing: int = -1
    const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight}) => {
        context.clearRect(0, 0, actualWidth, actualHeight)
        lane().ifSome(each => {
            const rhythm = Euclid.rhythmOf(each, edited)
            EuclidCircle.paint(context, actualWidth, actualHeight, {
                steps: stepsOf(each), repeats: rhythm.repeats.getValue(), fade: rhythm.fade.getValue(), playing,
                caption: `${rhythm.pulses.getValue()}/${rhythm.steps.getValue()}`, rate: Euclid.Values[rhythm.rate.getValue()] ?? ""
            })
        })
    }))
    lifecycle.own(engine.position.subscribe(() => {
        const step = lane().mapOr(stepOf, -1)
        if (step !== playing) {
            playing = step
            painter.requestUpdate()
        }
        dots.forEach(([each, dot]) => dot.classList.toggle("on", sounding(each)))
    }))
    lifecycle.own(observe(() => {
        renderList()
        updateTiles()
        grooveLabel.textContent = GrooveMenus.tooltip(project, box.patterns.fields()[edited].groove)().replace("Groove: ", "")
        painter.requestUpdate()
    }))
    const {green, blue, purple, red, orange, yellow} = Colors
    const controls: HTMLElement = (
        <div className={className}>
            {head("PATTERN", green, 1, 2)}
            {tiles}
            {parameter("Length", namedParameter.length, "6 / 1 / 8 / 2")}
            {parameter("Rate", namedParameter.rate, "6 / 2 / 8 / 3")}
            {control("Groove", grooveButton, "8 / 1 / 10 / 3")}
            <header style={{gridArea: "1 / 3 / -1 / 4"}}>{canvas}</header>
            {head("LANES", blue, 4, 3)}
            <div className="lanes-area" style={{gridArea: "2 / 4 / 10 / 7"}}>
                {list}
                <div className="buttons">
                    {button("+ Lane", addLane)}
                    {button("Roll Lane", () => roll(false))}
                    {button("Roll All", () => roll(true))}
                </div>
            </div>
            {head("NOTE", purple, 7, 1)}
            {control("Note", noteMenu(), area(7, 0))}
            {control("Gate", choice(Euclid.Gates, () => lane().map(each => each.gate)), area(7, 1))}
            {control("Chance", laneValue(each => each.chance, 0), area(7, 2))}
            {head("PULSES", red, 8, 1)}
            {control("Steps", rhythmValue(each => each.steps, 1, Euclid.MaxSteps), area(8, 0))}
            {control("Pulses", rhythmValue(each => each.pulses, 0, Euclid.MaxSteps), area(8, 1))}
            {control("Rotate", rhythmValue(each => each.rotate, 0, Euclid.MaxSteps - 1), area(8, 2))}
            {control("Rate", choice(Euclid.Values, () => rhythm().map(each => each.rate)), area(8, 3))}
            {head("ACCENT", orange, 9, 1)}
            {control("Steps", rhythmValue(each => each.accents, 0, Euclid.MaxSteps), area(9, 0))}
            {control("Rotate", rhythmValue(each => each.accentRotate, 0, Euclid.MaxSteps - 1), area(9, 1))}
            {control("Velocity", laneValue(each => each.velocity, 0), area(9, 2))}
            {head("BURST", yellow, 10, 1)}
            {control("Bursts", rhythmValue(each => each.bursts, 0, Euclid.MaxSteps), area(10, 0))}
            {control("Rotate", rhythmValue(each => each.burstRotate, 0, Euclid.MaxSteps - 1), area(10, 1))}
            {control("Repeats", rhythmValue(each => each.repeats, Euclid.MinRepeats, Euclid.MaxRepeats), area(10, 2))}
            {control("Fade", value(-1, 1, 0.01, percent, () => rhythm().mapOr(each => each.fade.getValue(), 0),
                next => rhythm().ifSome(each => each.fade.setValue(next)), fromPercent), area(10, 3))}
        </div>
    )
    changed.notify()
    return (
        <DeviceEditor lifecycle={lifecycle}
                      service={service}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => controls}
                      populateMeter={() => (
                          <DeviceMidiMeter lifecycle={lifecycle} receiver={liveStreamReceiver} address={adapter.address}/>
                      )}
                      icon={IconSymbol.Random}/>
    )
}
