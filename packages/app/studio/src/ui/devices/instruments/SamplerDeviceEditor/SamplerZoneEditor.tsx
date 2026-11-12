import css from "./SamplerZoneEditor.sass?inline"
import {
    Arrays, clamp, Exec, Func, int, isDefined, Lifecycle, MutableObservableValue, Notifier, ObservableValue, Observer,
    Optional, Point, Procedure, RuntimeNotifier, Subscription, UUID
} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {MidiKeys} from "@opendaw/lib-dsp"
import {BooleanField, Float32Field, Int32Field} from "@opendaw/lib-box"
import {SamplerZoneBox} from "@opendaw/studio-boxes"
import {
    DeviceHost, NoteSignal, NoteStreamReceiver, Sample, SamplerDeviceBoxAdapter, SamplerGroupBoxAdapter, SamplerZoneBoxAdapter, SamplerZones
} from "@opendaw/studio-adapters"
import {CanvasPainter, FilePickerAcceptTypes, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {ControlContext} from "../NanoDeviceEditor/ParameterControls"
import {SamplerModulationList} from "./SamplerModulationList"
import {SamplerSamples} from "./SamplerSamples"
import {SamplerStacks} from "./SamplerStacks"
import {SamplerText} from "./SamplerText"
import {SamplerValueLabel} from "./SamplerValueLabel"
import {SamplerVoiceStacks} from "./SamplerVoiceStacks"
import {SamplerZoneMap} from "./SamplerZoneMap"

const className = Html.adoptStyleSheet(css, "SamplerZoneEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SamplerDeviceBoxAdapter
    deviceHost: DeviceHost
}

type Zone = SamplerZoneBoxAdapter
type NumberField = Int32Field | Float32Field

type Origin = {
    readonly zone: Zone
    readonly keyLow: int
    readonly keyHigh: int
    readonly velocityLow: int
    readonly velocityHigh: int
    readonly rootKey: int
}

type Drag = {
    readonly edge: SamplerZoneMap.Edge
    readonly key: int
    readonly velocity: int
    readonly origins: ReadonlyArray<Origin>
    // the zones a click without a move collapses the selection to
    readonly collapse: Optional<ReadonlyArray<Zone>>
    // where the pointer went down, and whether the click before went down there too
    readonly at: Point
    readonly again: boolean
    readonly hit: Zone
}

type Band = {
    readonly key: int
    readonly velocity: int
    readonly keep: ReadonlyArray<Zone>
}

const Cursors: Readonly<Record<SamplerZoneMap.Edge, string>> =
    {move: "", left: "ew-resize", right: "ew-resize", top: "ns-resize", bottom: "ns-resize"}
const EdgeReach = 5
const MaxKey = SamplerZoneMap.NumKeys - 1
const {RoundRobinNames, TriggerNames} = SamplerGroupBoxAdapter
const RobinCycle = 1
const MarkerReach = 6
const ClickReach = 3
const LoopModeNames: ReadonlyArray<string> = ["Off", "On", "Always"]

type Format = { readonly print: Func<number, SamplerValueLabel.Printed>, readonly parse: Func<string, Optional<number>> }

const NoteOffsets: Readonly<Record<string, int>> = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}
const {numberIn} = SamplerValueLabel
// a key as the studio writes it (C3 is key 60), or as a number
const parseKey = (text: string): Optional<number> => {
    const note = /^\s*([a-g])(#?)(-?\d)\s*$/i.exec(text)
    return isDefined(note) ? NoteOffsets[note[1].toLowerCase()] + (note[2] === "#" ? 1 : 0) + (parseInt(note[3]) + 2) * 12 : numberIn(text)
}
const printSeconds = (value: number): SamplerValueLabel.Printed =>
    value < 1.0 ? [String(Math.round(value * 1000)), "ms"] : [value.toFixed(2), "s"]
const parseSeconds = (text: string): Optional<number> => {
    const value = numberIn(text)
    return !isDefined(value) ? undefined : /ms/i.test(text) || (!/s/i.test(text) && value >= 10) ? value / 1000 : value
}
const format = {
    integer: (unit: string): Format => ({print: value => [String(Math.round(value)), unit], parse: text => numberIn(text)}),
    fixed: (digits: int, unit: string): Format => ({print: value => [value.toFixed(digits), unit], parse: text => numberIn(text)}),
    percent: {
        print: value => [String(Math.round(value * 100)), "%"],
        parse: text => {
            const value = numberIn(text)
            return isDefined(value) ? value / 100 : undefined
        }
    } satisfies Format,
    key: {print: value => [MidiKeys.toFullString(Math.round(value)), ""], parse: parseKey} satisfies Format,
    pan: {
        print: value => Math.round(value * 100) === 0 ? ["C", ""] : [String(Math.abs(Math.round(value * 100))), value < 0 ? "L" : "R"],
        parse: text => {
            const value = numberIn(text)
            return /^\s*c\s*$/i.test(text) ? 0.0 : !isDefined(value) ? undefined : (/l/i.test(text) ? -Math.abs(value) : value) / 100
        }
    } satisfies Format,
    seconds: {print: printSeconds, parse: parseSeconds} satisfies Format
}

// The content of the sample zone window: the key × velocity map with its piano, the groups, sample zones and
// modulation slots, the focused zone's sample and fields, and every parameter of the device panel.
export const SamplerZoneEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, boxGraph, engine, liveStreamReceiver} = project
    const notes = lifecycle.own(new NoteStreamReceiver(liveStreamReceiver, deviceHost.audioUnitBoxAdapter().address))
    const refresh = lifecycle.own(new Notifier<void>())
    const observe = (update: Procedure<void>): Subscription => refresh.subscribe(update)
    const unitUuid = deviceHost.audioUnitBoxAdapter().uuid
    let entries = SamplerZoneMap.entries(adapter)
    let selection: ReadonlyArray<Zone> = []
    let focused: Optional<Zone> = undefined
    let shownGroup: Optional<SamplerGroupBoxAdapter> = undefined
    let pressed: int = -1
    let drag: Optional<Drag> = undefined
    let dragMoved: boolean = false
    let lastClick: Optional<Point> = undefined
    let band: Optional<Band> = undefined
    let rect: Optional<SamplerZoneMap.Range> = undefined
    let groupsSignature = ""
    let zonesSignature = ""
    let sampleRows: ReadonlyArray<[ReadonlyArray<Zone>, HTMLElement]> = []
    const state = (): SamplerZoneMap.State => ({
        entries, selection: new Set(selection), group: shownGroup?.indexField.getValue() ?? -1, pressed, rect,
        isNoteOn: key => notes.isNoteOn(key)
    })
    const shownZones = (): ReadonlyArray<Zone> => adapter.zones.adapters()
        .filter(zone => !isDefined(shownGroup) || zone.group().contains(shownGroup))
    const union = (first: ReadonlyArray<Zone>, second: ReadonlyArray<Zone>): ReadonlyArray<Zone> =>
        [...first, ...second.filter(zone => !first.includes(zone))]
    const select = (zones: ReadonlyArray<Zone>, focus?: Zone): void => {
        selection = zones
        lastClick = undefined
        focused = focus ?? (isDefined(focused) && zones.includes(focused) ? focused : zones.at(0))
    }
    // shift, cmd or ctrl adds the zones or takes them out again
    const toggleSelect = (zones: ReadonlyArray<Zone>): void => {
        if (zones.every(zone => selection.includes(zone))) {
            select(selection.filter(zone => !zones.includes(zone)))
        } else {
            select(union(selection, zones), zones[0])
        }
    }
    const hasModifier = (event: MouseEvent): boolean => event.shiftKey || event.metaKey || event.ctrlKey
    const boxes = (): ReadonlyArray<SamplerZoneBox> => selection.map(zone => zone.box)
    const framesOf = (zone: Zone): Optional<{ numberOfFrames: int, sampleRate: number }> =>
        zone.file().flatMap(file => file.data).unwrapOrUndefined()
    const zoneField = (name: string, field: Func<SamplerZoneBox, NumberField>, min: number, max: number, step: number,
                       {print, parse}: Format, settle?: Procedure<SamplerZoneBox>): SamplerValueLabel.Field => ({
        name, min, max, step, print, parse,
        available: () => isDefined(focused),
        spread: () => {
            const values = selection.map(({box}) => field(box).getValue())
            const low = Math.min(...values), high = Math.max(...values)
            return values.length > 1 && low !== high ? [low, high] : undefined
        },
        get: () => isDefined(focused) ? field(focused.box).getValue() : 0,
        set: value => {
            if (!isDefined(focused)) {return}
            const delta = value - field(focused.box).getValue()
            selection.forEach(({box}) => {
                const target = field(box)
                target.setValue(clamp(target.getValue() + delta, min, max))
                settle?.(box)
            })
        }
    })
    // a position in the sample, edited as a share of its length and stored in frames
    const frameField = (name: string, field: Func<SamplerZoneBox, Int32Field>): SamplerValueLabel.Field => {
        const unitOf = (zone: Zone): number => {
            const frames = framesOf(zone)
            return isDefined(frames) && frames.numberOfFrames > 0
                ? Math.min(field(zone.box).getValue(), frames.numberOfFrames) / frames.numberOfFrames : 0.0
        }
        return {
            name, min: 0.0, max: 1.0, step: 0.002,
            print: unit => {
                const frames = isDefined(focused) ? framesOf(focused) : undefined
                return isDefined(frames) ? printSeconds(unit * frames.numberOfFrames / frames.sampleRate) : SamplerValueLabel.Unavailable
            },
            parse: text => {
                const frames = isDefined(focused) ? framesOf(focused) : undefined
                const seconds = parseSeconds(text)
                return isDefined(frames) && isDefined(seconds) && frames.numberOfFrames > 0
                    ? seconds * frames.sampleRate / frames.numberOfFrames : undefined
            },
            available: () => isDefined(focused) && isDefined(framesOf(focused)),
            spread: () => {
                const units = selection.filter(zone => isDefined(framesOf(zone))).map(unitOf)
                const low = Math.min(...units), high = Math.max(...units)
                return units.length > 1 && low !== high ? [low, high] : undefined
            },
            get: () => isDefined(focused) ? unitOf(focused) : 0.0,
            set: value => {
                if (!isDefined(focused)) {return}
                const delta = value - unitOf(focused)
                selection.forEach(zone => {
                    const frames = framesOf(zone)
                    if (!isDefined(frames)) {return}
                    field(zone.box).setValue(Math.round(clamp(unitOf(zone) + delta, 0.0, 1.0) * frames.numberOfFrames))
                })
            }
        }
    }
    const currentGroup = (): Optional<SamplerGroupBoxAdapter> => focused?.group().unwrapOrUndefined() ?? shownGroup
    const groupField = (name: string, field: Func<SamplerGroupBoxAdapter, Int32Field>, max: number,
                        {print, parse}: Format): SamplerValueLabel.Field => ({
        name, min: 0, max, step: 1, print, parse,
        available: () => isDefined(currentGroup()),
        get: () => {
            const group = currentGroup()
            return isDefined(group) ? field(group).getValue() : 0
        },
        set: value => {
            const group = currentGroup()
            if (isDefined(group)) {field(group).setValue(Math.round(value))}
        }
    })
    const choice = (name: string, names: ReadonlyArray<string>, model: Omit<SamplerValueLabel.Choice, "names">): SamplerStacks.Cell =>
        ({name, control: SamplerValueLabel.choice(lifecycle, observe, {names, ...model})})
    const groupChoice = (field: Func<SamplerGroupBoxAdapter, Int32Field>): Omit<SamplerValueLabel.Choice, "names"> => ({
        available: () => isDefined(currentGroup()),
        get: () => {
            const group = currentGroup()
            return isDefined(group) ? field(group).getValue() : 0
        },
        set: index => {
            const group = currentGroup()
            if (isDefined(group)) {editing.modify(() => field(group).setValue(index))}
        }
    })
    const value = (field: SamplerValueLabel.Field): SamplerStacks.Cell =>
        ({name: field.name, control: SamplerValueLabel.create(lifecycle, editing, observe, field)})
    const toggle = (name: string, field: Func<SamplerZoneBox, BooleanField>): SamplerStacks.Cell => {
        const model = new class implements MutableObservableValue<boolean> {
            getValue(): boolean {return isDefined(focused) && field(focused.box).getValue()}
            setValue(value: boolean): void {editing.modify(() => selection.forEach(({box}) => field(box).setValue(value)))}
            subscribe(observer: Observer<ObservableValue<boolean>>): Subscription {return refresh.subscribe(() => observer(this))}
            catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
                observer(this)
                return this.subscribe(observer)
            }
        }
        return {
            name, control: (
                <Checkbox lifecycle={lifecycle} model={model} className="toggle"
                          appearance={{color: Colors.shadow, activeColor: Colors.green}}>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
            )
        }
    }
    const map: HTMLCanvasElement = <canvas/>
    const keys: HTMLCanvasElement = <canvas/>
    const waveform: HTMLCanvasElement = <canvas/>
    const playheads: HTMLCanvasElement = <canvas className="playheads"/>
    // the zones in the order of the device's table rows
    let rows: ReadonlyArray<Zone> = []
    const mapDisplay: HTMLElement = <div className="display map">{map}</div>
    const sampleLabel: HTMLElement = <span className="file-name"/>
    const presetName: HTMLElement = (
        <span className="preset" ondblclick={async (event: MouseEvent) => {
            const label = adapter.labelField
            const typed = (await Surface.get(presetName).requestFloatingTextInput(event, label.getValue())).trim()
            if (typed.length > 0 && typed !== label.getValue() && adapter.box.isAttached()) {
                editing.modify(() => label.setValue(typed))
            }
        }}/>
    )
    const sampleCount: HTMLElement = <span className="samples"/>
    const selectionLabel: HTMLElement = <span className="count"/>
    const readout: HTMLElement = <span className="readout"/>
    const newGroupName = (): string => {
        const names = adapter.groups.adapters().map(group => group.box.label.getValue())
        let number = names.length + 1
        while (names.includes(`Group ${number}`)) {number++}
        return `Group ${number}`
    }
    const addGroup: HTMLElement = (
        <div className="add" onclick={() => editing.modify(() =>
            SamplerZones.createGroup(boxGraph, adapter.box, newGroupName()))}>Add</div>
    )
    const groupList: HTMLElement = <div className="rows"/>
    const zoneList: HTMLElement = <div className="rows"/>
    const stackList: HTMLElement = <div className="rows"/>
    const stackTitle: HTMLElement = <span/>
    const waveformDisplay: HTMLElement = (
        <div className="display waveform">
            {waveform}
            {playheads}
            {sampleLabel}
        </div>
    )
    const stackHint: HTMLElement = <div className="hint">Click a zone on the map. Drop samples here to add them to its range.</div>
    let stackRows: ReadonlyArray<[Zone, HTMLElement]> = []
    let stackSignature = ""
    const painters: ReadonlyArray<CanvasPainter> = [
        new CanvasPainter(map, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            SamplerZoneMap.paint(context, actualWidth, actualHeight, devicePixelRatio, state())),
        new CanvasPainter(keys, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            SamplerZoneMap.paintKeyboard(context, actualWidth, actualHeight, devicePixelRatio, state())),
        new CanvasPainter(waveform, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            SamplerZoneMap.paintWaveform(context, actualWidth, actualHeight, devicePixelRatio, focused))
    ]
    let scheduled = false
    const schedule = (): void => {
        if (scheduled) {return}
        scheduled = true
        queueMicrotask(() => {
            scheduled = false
            refresh.notify()
        })
    }
    const fileNameOf = (zone: Zone): string => zone.file().mapOr(file => file.box.fileName.getValue(), "No sample")
    const updateGroups = (): void => {
        const groups = adapter.groups.adapters()
        const zones = adapter.zones.adapters()
        const signature = `${shownGroup?.indexField.getValue() ?? -1}|` + groups.map(group =>
            `${group.indexField.getValue()}/${group.box.label.getValue()}/${group.zones.adapters().length}`).join("|") + `|${zones.length}`
        if (signature === groupsSignature) {return}
        groupsSignature = signature
        const row = (group: Optional<SamplerGroupBoxAdapter>, name: string, count: int): HTMLElement => (
            <div className={Html.buildClassList("row", group === shownGroup && "active")} onclick={() => {
                shownGroup = group
                if (isDefined(group)) {select(selection.filter(zone => zone.group().contains(group)))}
                refresh.notify()
            }} ondblclick={async (event: MouseEvent) => {
                if (!isDefined(group)) {return}
                const label = group.box.label
                const typed = (await Surface.get(groupList).requestFloatingTextInput(event, label.getValue())).trim()
                if (typed.length > 0 && typed !== label.getValue() && group.box.isAttached()) {
                    editing.modify(() => label.setValue(typed))
                }
            }}>
                <i style={{backgroundColor: SamplerZoneMap.groupColor(group?.indexField.getValue() ?? -1).toString()}}/>
                <span>{name}</span>
                <span className="count">{String(count)}</span>
                {isDefined(group) && groups.length > 1 && (
                    <div className="remove" onclick={(event: MouseEvent) => {
                        event.stopPropagation()
                        removeGroup(group)
                    }}><Icon symbol={IconSymbol.Close}/></div>
                )}
            </div>
        )
        groupList.replaceChildren(row(undefined, "All", zones.length),
            ...groups.map(group => row(group, group.box.label.getValue(), group.zones.adapters().length)), addGroup)
    }
    // one row per sample, a click selects every zone that plays it
    const updateZones = (): void => {
        const samples = new Map<string, Array<Zone>>()
        shownZones().forEach(zone => {
            const sample = `${zone.file().mapOr(file => UUID.toString(file.uuid), "")}/${zone.box.enabled.getValue()}`
            samples.set(sample, [...(samples.get(sample) ?? []), zone])
        })
        const signature = Array.from(samples, ([sample, zones]) =>
            `${sample}/${fileNameOf(zones[0])}/${zones.map(zone => `${UUID.toString(zone.uuid)}${zone.box.enabled.getValue()}`).join(",")}`).join("|")
        if (signature !== zonesSignature) {
            zonesSignature = signature
            sampleRows = Array.from(samples, ([_, zones]) => [zones, (
                <div className={Html.buildClassList("row", zones.every(zone => !zone.box.enabled.getValue()) && "off")}
                     onclick={(event: MouseEvent) => {
                         if (hasModifier(event)) {toggleSelect(zones)} else {select(zones, zones[0])}
                         refresh.notify()
                     }}>
                    <span>{fileNameOf(zones[0]).replace(/\.[A-Za-z0-9]+$/, "")}</span>
                    <span className="count">{String(zones.length)}</span>
                </div>
            )])
            zoneList.replaceChildren(...sampleRows.map(([_, row]) => row))
        }
        sampleRows.forEach(([zones, row]) => {
            row.classList.toggle("active", isDefined(focused) && zones.includes(focused))
            row.classList.toggle("selected", zones.every(zone => selection.includes(zone)))
        })
        const active = sampleRows.find(([zones]) => isDefined(focused) && zones.includes(focused))?.[1]
        if (isDefined(active) && !isDefined(drag) && !isDefined(band)) {
            if (active.offsetTop < zoneList.scrollTop + 8) {
                zoneList.scrollTop = active.offsetTop - 8
            } else if (active.offsetTop + active.offsetHeight > zoneList.scrollTop + zoneList.clientHeight - 8) {
                zoneList.scrollTop = active.offsetTop + active.offsetHeight - zoneList.clientHeight + 8
            }
        }
    }
    const robinMode = (): int => focused?.group().mapOr(group => group.box.roundRobin.getValue(), 0) ?? 0
    const turnOrder = (zone: Zone): ReadonlyArray<Zone> => SamplerZoneMap.robinsOf(state(), zone)
        .toSorted((left, right) => left.box.sequence.getValue() - right.box.sequence.getValue()
            || UUID.Comparator(left.uuid, right.uuid))
    // the zones on the focused zone's range in their turn order: picked, reordered, taken off, given another sample
    const updateStack = (): void => {
        const mode = robinMode()
        const zones = isDefined(focused) ? turnOrder(focused) : []
        stackTitle.textContent = zones.length === 0 ? "Zones on This Range"
            : `${SamplerText.count(zones.length, "Zone", "Zones")} on This Range`
        stackHint.classList.toggle("hidden", zones.length > 0)
        const signature = `${mode}|` + zones.map(zone => `${UUID.toString(zone.uuid)}/${fileNameOf(zone)}/`
            + `${zone.box.panning.getValue()}/${zone.box.gain.getValue()}`).join("|")
        if (signature !== stackSignature) {
            stackSignature = signature
            buildStack(zones, mode)
        }
        stackRows.forEach(([zone, row]) => {
            row.classList.toggle("active", zone === focused)
            row.classList.toggle("selected", selection.includes(zone))
        })
    }
    const buildStack = (zones: ReadonlyArray<Zone>, mode: int): void => {
        stackRows = zones.map((zone, index) => {
            let grab: Optional<{ readonly y: number, moved: boolean }> = undefined
            const row: HTMLElement = (
                <div className="row"
                     onpointerdown={(event: PointerEvent) => {
                         if (event.button !== 0) {return}
                         row.setPointerCapture(event.pointerId)
                         grab = {y: event.clientY, moved: false}
                     }}
                     onpointermove={(event: PointerEvent) => {
                         if (!isDefined(grab) || mode !== RobinCycle || zones.length < 2) {return}
                         const delta = event.clientY - grab.y
                         if (Math.abs(delta) > 3) {grab.moved = true}
                         if (grab.moved) {row.style.transform = `translateY(${delta}px)`}
                     }}
                     onpointerup={(event: PointerEvent) => {
                         const released = grab
                         grab = undefined
                         row.style.transform = ""
                         if (!isDefined(released)) {return}
                         const to = clamp(index + Math.round((event.clientY - released.y) / row.offsetHeight), 0, zones.length - 1)
                         if (released.moved && to !== index) {
                             const order = zones.filter(other => other !== zone)
                             order.splice(to, 0, zone)
                             editing.modify(() => SamplerZones.reorder(order.map(other => other.box)))
                         } else {
                             select([zone], zone)
                         }
                         refresh.notify()
                     }}
                     onpointercancel={() => {
                         grab = undefined
                         row.style.transform = ""
                         refresh.notify()
                     }}>
                    <span className="turn">{mode === RobinCycle && zones.length > 1 ? String(index + 1) : ""}</span>
                    <span>{fileNameOf(zone).replace(/\.[A-Za-z0-9]+$/, "")}</span>
                    <span className="count">{format.pan.print(zone.box.panning.getValue()).join(" ")}</span>
                    <span className="count">{`${zone.box.gain.getValue().toFixed(1)} dB`}</span>
                    <div className="remove" onpointerdown={(event: PointerEvent) => event.stopPropagation()} onclick={() => {
                        editing.modify(() => SamplerZones.disable([zone.box]))
                        select(zones.filter(other => other !== zone), zones.find(other => other !== zone))
                        refresh.notify()
                    }}><Icon symbol={IconSymbol.Close}/></div>
                </div>
            )
            return [zone, row]
        })
        stackList.replaceChildren(...stackRows.map(([_, row]) => row), stackHint)
    }
    // on the waveform a drop replaces the sample, on a range it joins, on the empty map it takes the key
    const dropped = (event: DragEvent): Procedure<ReadonlyArray<Sample>> => {
        const target = event.target
        const within = (element: HTMLElement): boolean => target instanceof Node && element.contains(target)
        const row = within(waveformDisplay) ? focused : undefined
        const onStack = within(stackPanel) ? focused : undefined
        const group = shownGroup?.box
        const {x, y, width, height} = pointerOf(map, event)
        const onMap = within(mapDisplay)
        const hit = onMap ? SamplerZoneMap.hit(state(), x, y, width, height, 0).mapOr(({zones}) => zones.at(0), undefined) : undefined
        const key = onMap ? SamplerZoneMap.keyAt(x, width) : undefined
        const velocity = SamplerZoneMap.velocityAt(y, height)
        // a lone zone over the whole keyboard is no place to join: the drop names a key
        const covering = isDefined(hit) && hit.box.keyLow.getValue() === 0 && hit.box.keyHigh.getValue() === MaxKey
        const range = onStack ?? (covering ? undefined : hit)
        const gapAt = (zones: ReadonlyArray<SamplerZoneBox>, at: int): [int, int] => {
            const others = SamplerZoneMap.entries(adapter).filter(entry => !zones.includes(entry.zone.box)
                && entry.keyLow <= at && entry.keyHigh >= at)
            const low = Math.max(SamplerZoneMap.MinVelocity, ...others.filter(entry => entry.velocityHigh < velocity).map(entry => entry.velocityHigh + 1))
            const high = Math.min(SamplerZoneMap.MaxVelocity, ...others.filter(entry => entry.velocityLow > velocity).map(entry => entry.velocityLow - 1))
            return [low, high]
        }
        return samples => {
            if (samples.length === 0 || !adapter.box.isAttached()) {return}
            if (isDefined(row)) {
                if (!row.box.isAttached()) {return}
                added(editing.modify(() => {
                    SamplerZones.replaceSample(boxGraph, [row.box], samples[0])
                    return SamplerZones.addToStack(boxGraph, adapter.box, row.box, samples.slice(1))
                }).unwrapOrElse(Arrays.empty()))
                refresh.notify()
                return
            }
            added(editing.modify(() => {
                if (isDefined(range) && range.box.isAttached()) {return SamplerZones.addToStack(boxGraph, adapter.box, range.box, samples)}
                const created = SamplerZones.addSamples(boxGraph, adapter.box, isDefined(group) && group.isAttached() ? group : undefined, samples, key)
                if (isDefined(key) && !covering) {
                    const [low, high] = gapAt(created, key)
                    created.filter(zone => zone.keyLow.getValue() === key && low <= high).forEach(zone => {
                        zone.velocityLow.setValue(low)
                        zone.velocityHigh.setValue(high)
                    })
                }
                return created
            }).unwrapOrElse(Arrays.empty()))
        }
    }
    const removeGroup = async (group: SamplerGroupBoxAdapter): Promise<void> => {
        const count = group.zones.adapters().length
        if (count > 0 && !await RuntimeNotifier.approve({
            headline: "Delete Group",
            message: `'${group.box.label.getValue()}' has ${SamplerText.count(count, "sample zone", "sample zones")}. `
                + `${count === 1 ? "It is" : "They are"} deleted with the group.`,
            approveText: "Delete"
        })) {return}
        if (!group.box.isAttached()) {return}
        if (shownGroup === group) {shownGroup = undefined}
        editing.modify(() => SamplerZones.removeGroup(adapter.box, group.box))
        refresh.notify()
    }
    // start, end and the loop points of the focused zone, as shares of its sample
    type Marker = { readonly field: Int32Field, readonly unit: number }
    const markers = (zone: Zone): ReadonlyArray<Marker> => {
        const frames = framesOf(zone)
        if (!isDefined(frames) || frames.numberOfFrames === 0) {return Arrays.empty()}
        const {sampleStart, sampleEnd, loopStart, loopEnd, loopMode} = zone.box
        const unit = (field: Int32Field): number => Math.min(field.getValue(), frames.numberOfFrames) / frames.numberOfFrames
        const start = unit(sampleStart), end = Math.max(start, unit(sampleEnd))
        const edges: ReadonlyArray<Marker> = [{field: sampleStart, unit: start}, {field: sampleEnd, unit: end}]
        if (loopMode.getValue() === 0) {return edges}
        const from = clamp(unit(loopStart), start, end), to = clamp(unit(loopEnd), from, end)
        return [{field: loopStart, unit: from}, {field: loopEnd, unit: to}, ...edges]
    }
    // where a loop point sits on the start or the end, the upper half grabs the loop point
    const markerAt = (event: PointerEvent): Optional<Marker> => {
        if (!isDefined(focused)) {return undefined}
        const {x, y, width, height} = pointerOf(waveform, event)
        const near = markers(focused).map(marker => ({marker, distance: Math.abs(marker.unit * width - x)}))
            .filter(({distance}) => distance <= MarkerReach)
        const loops = focused.box.loopMode.getValue() !== 0 && y < height * 0.5
        const isEnd = (field: Int32Field): boolean => field === focused?.box.sampleEnd || field === focused?.box.loopEnd
        // of two markers on one spot the one that can still move that way: the end to the right, the start to the left
        const rank = ({marker}: { marker: Marker }): int =>
            (isLoopField(marker.field) === loops ? 0 : 2) + (isEnd(marker.field) === (x >= marker.unit * width) ? 0 : 1)
        return near.toSorted((left, right) => left.distance - right.distance || rank(left) - rank(right)).at(0)?.marker
    }
    const isLoopField = (field: Int32Field): boolean =>
        isDefined(focused) && (field === focused.box.loopStart || field === focused.box.loopEnd)
    let markerDrag: Optional<Int32Field> = undefined
    let markerMoved = false
    const updateLabels = (): void => {
        const zones = adapter.zones.adapters()
        const files = new Set(zones.map(zone => zone.file().unwrapOrUndefined()).filter(isDefined))
        const used = new Set(zones.filter(zone => zone.box.enabled.getValue()).map(zone => zone.file().unwrapOrUndefined()).filter(isDefined))
        presetName.textContent = adapter.labelField.getValue()
        sampleCount.textContent = `${SamplerText.count(files.size, "sample", "samples")}, ${files.size - used.size} unused`
        selectionLabel.textContent = `${selection.length} of ${SamplerText.count(zones.length, "sample zone", "sample zones")} selected`
        const zone = focused
        const robins = isDefined(zone) ? turnOrder(zone) : []
        // zones on the same range take turns when their group has a round robin, else they sound together
        const role = isDefined(zone) && zone.group().mapOr(group => group.box.roundRobin.getValue() !== 0, false) ? "round robin" : "layer"
        sampleLabel.textContent = !isDefined(zone) ? "No sample zone selected" : robins.length > 1
            ? `${fileNameOf(zone)} (${role} ${robins.indexOf(zone) + 1} of ${robins.length})` : fileNameOf(zone)
    }
    // a sample that finishes loading brings its waveform and its length
    const watched = UUID.newSet<UUID.Bytes>(uuid => uuid)
    const watchLoaders = (): void => adapter.zones.adapters().forEach(zone => zone.file().ifSome(file => {
        if (watched.hasKey(file.uuid)) {return}
        watched.add(file.uuid)
        lifecycle.own(file.getOrCreateLoader().subscribe(loaderState => {
            if (loaderState.type === "loaded") {schedule()}
        }))
    }))
    const update = (): void => {
        entries = SamplerZoneMap.entries(adapter)
        rows = adapter.zones.adapters().toSorted((left, right) => UUID.Comparator(left.uuid, right.uuid))
        watchLoaders()
        const attached = selection.filter(zone => zone.box.isAttached())
        if (attached.length !== selection.length) {select(attached)}
        if (isDefined(shownGroup) && !shownGroup.box.isAttached()) {shownGroup = undefined}
        updateGroups()
        updateZones()
        updateStack()
        updateLabels()
        painters.forEach(painter => painter.requestUpdate())
    }
    const pointerOf = (canvas: HTMLCanvasElement, event: MouseEvent): { x: number, y: number, width: number, height: number } => {
        const {left, top, width, height} = canvas.getBoundingClientRect()
        return {x: event.clientX - left, y: event.clientY - top, width, height}
    }
    const applyDrag = ({edge, key, velocity, origins}: Drag, toKey: int, toVelocity: int): void => {
        const keyDelta = edge === "move"
            ? clamp(toKey - key, -Math.min(...origins.map(origin => origin.keyLow)),
                MaxKey - Math.max(...origins.map(origin => origin.keyHigh))) : toKey - key
        const velocityDelta = edge === "move"
            ? clamp(toVelocity - velocity, SamplerZoneMap.MinVelocity - Math.min(...origins.map(origin => origin.velocityLow)),
                SamplerZoneMap.MaxVelocity - Math.max(...origins.map(origin => origin.velocityHigh))) : toVelocity - velocity
        origins.forEach(({zone: {box}, keyLow, keyHigh, velocityLow, velocityHigh, rootKey}) => {
            if (edge === "move") {
                box.keyLow.setValue(keyLow + keyDelta)
                box.keyHigh.setValue(keyHigh + keyDelta)
                box.rootKey.setValue(clamp(rootKey + keyDelta, 0, MaxKey))
                box.velocityLow.setValue(velocityLow + velocityDelta)
                box.velocityHigh.setValue(velocityHigh + velocityDelta)
            } else if (edge === "left") {
                box.keyLow.setValue(clamp(keyLow + keyDelta, 0, keyHigh))
            } else if (edge === "right") {
                box.keyHigh.setValue(clamp(keyHigh + keyDelta, keyLow, MaxKey))
            } else if (edge === "top") {
                box.velocityHigh.setValue(clamp(velocityHigh + velocityDelta, velocityLow, SamplerZoneMap.MaxVelocity))
            } else {
                box.velocityLow.setValue(clamp(velocityLow + velocityDelta, SamplerZoneMap.MinVelocity, velocityHigh))
            }
        })
    }
    const play = (event: PointerEvent): void => {
        const {x, y, width, height} = pointerOf(keys, event)
        const key = SamplerZoneMap.keyboardKeyAt(x, y, width, height)
        if (key === pressed) {return}
        if (pressed !== -1) {engine.noteSignal(NoteSignal.off(unitUuid, pressed))}
        pressed = key
        // lower on the key is louder, as on the studio's keyboard
        const velocity = clamp(0.25 + 0.75 * y / height, 0.0, 1.0)
        engine.noteSignal(NoteSignal.on(unitUuid, key, velocity))
        const answering = SamplerZoneMap.answering(state(), key, Math.max(1, Math.round(velocity * 127)))
        if (answering.length > 0) {select(answering)}
        refresh.notify()
    }
    const release = (): void => {
        if (pressed === -1) {return}
        engine.noteSignal(NoteSignal.off(unitUuid, pressed))
        pressed = -1
        refresh.notify()
    }
    const added = (created: ReadonlyArray<SamplerZoneBox>): void => {
        if (created.length === 0) {return}
        select(adapter.zones.adapters().filter(zone => created.includes(zone.box)))
        refresh.notify()
    }
    const browse = async (): Promise<void> => {
        const {status, value: files} = await Promises.tryCatch(Files.open({...FilePickerAcceptTypes.WavFiles, multiple: true}))
        if (status === "resolved") {added(SamplerSamples.add(project, adapter, shownGroup?.box, await SamplerSamples.importFiles(service, project, files)))}
    }
    const tool = (label: string, tooltip: string, action: Exec): JsxValue => (
        <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip}} onClick={() => {
            editing.modify(action)
            refresh.notify()
        }}><span>{label}</span></Button>
    )
    const context: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    const voice = SamplerVoiceStacks.create(context, adapter, project.timelineBox.bpm)
    lifecycle.ownAll(
        ...painters,
        refresh.subscribe(update),
        notes.subscribe(() => painters[1].requestUpdate()),
        liveStreamReceiver.subscribeFloats(adapter.positionsAddress, positions => {
            const context = playheads.getContext("2d")
            if (!isDefined(context)) {return}
            const scale = devicePixelRatio
            playheads.width = playheads.clientWidth * scale
            playheads.height = playheads.clientHeight * scale
            const frames = isDefined(focused) ? framesOf(focused) : undefined
            SamplerZoneMap.paintPlayheads(context, playheads.width, playheads.height, scale, positions,
                isDefined(focused) ? rows.indexOf(focused) : -1, frames?.numberOfFrames ?? 0)
        }),
        boxGraph.subscribeToAllUpdates({onUpdate: schedule}),
        adapter.labelField.subscribe(schedule),
        Events.subscribe(map, "pointerdown", (event: PointerEvent) => {
            if (event.button !== 0) {return}
            const {x, y, width, height} = pointerOf(map, event)
            const key = SamplerZoneMap.keyAt(x, width)
            const velocity = SamplerZoneMap.velocityAt(y, height)
            const again = isDefined(lastClick) && Math.abs(lastClick.x - x) <= ClickReach && Math.abs(lastClick.y - y) <= ClickReach
            map.setPointerCapture(event.pointerId)
            SamplerZoneMap.hit(state(), x, y, width, height, EdgeReach).match({
                none: () => {
                    band = {key, velocity, keep: hasModifier(event) ? selection : []}
                    rect = {keyLow: key, keyHigh: key, velocityLow: velocity, velocityHigh: velocity}
                    select(band.keep)
                },
                some: ({zones, edge}) => {
                    if (hasModifier(event)) {
                        toggleSelect(zones)
                        return
                    }
                    const chosen = zones.every(zone => selection.includes(zone))
                    const collapse = chosen && selection.length > zones.length
                    if (!chosen) {select(zones)} else if (!isDefined(focused) || !zones.includes(focused)) {focused = zones[0]}
                    dragMoved = false
                    drag = {
                        edge, key, velocity, collapse: collapse ? zones : undefined,
                        at: {x, y}, again: chosen && !collapse && again, hit: zones[0],
                        origins: selection.map(zone => ({
                            zone, keyLow: zone.box.keyLow.getValue(), keyHigh: zone.box.keyHigh.getValue(),
                            velocityLow: zone.box.velocityLow.getValue(), velocityHigh: zone.box.velocityHigh.getValue(),
                            rootKey: zone.box.rootKey.getValue()
                        }))
                    }
                }
            })
            refresh.notify()
        }),
        Events.subscribe(map, "pointermove", (event: PointerEvent) => {
            const {x, y, width, height} = pointerOf(map, event)
            const key = SamplerZoneMap.keyAt(x, width)
            const velocity = SamplerZoneMap.velocityAt(y, height)
            readout.textContent = `${MidiKeys.toFullString(key)} / ${velocity}`
            if (isDefined(drag)) {
                const still = Math.abs(x - drag.at.x) <= ClickReach && Math.abs(y - drag.at.y) <= ClickReach
                if (!dragMoved && (still || (key === drag.key && velocity === drag.velocity))) {return}
                dragMoved = true
                const current = drag
                editing.modify(() => applyDrag(current, key, velocity), false)
            } else if (isDefined(band)) {
                rect = {
                    keyLow: Math.min(band.key, key), keyHigh: Math.max(band.key, key),
                    velocityLow: Math.min(band.velocity, velocity), velocityHigh: Math.max(band.velocity, velocity)
                }
                select(union(band.keep, SamplerZoneMap.within(state(), rect)))
                refresh.notify()
            } else {
                map.style.cursor = SamplerZoneMap.hit(state(), x, y, width, height, EdgeReach).mapOr(({edge}) => Cursors[edge], "")
            }
        }),
        Events.subscribe(map, "pointerup", () => {
            if (isDefined(drag)) {
                if (dragMoved) {
                    editing.mark()
                } else if (isDefined(drag.collapse)) {
                    select(drag.collapse)
                } else if (drag.again) {
                    const {width, height} = map.getBoundingClientRect()
                    const behind = SamplerZoneMap.behind(state(), drag.at.x, drag.at.y, width, height, drag.hit)
                    if (behind.length > 0) {select(behind)}
                }
                lastClick = dragMoved ? undefined : drag.at
            }
            drag = undefined
            band = undefined
            rect = undefined
            refresh.notify()
        }),
        Events.subscribe(map, "pointercancel", () => {
            if (isDefined(drag) && dragMoved) {editing.revertPending()}
            drag = undefined
            band = undefined
            rect = undefined
            lastClick = undefined
            refresh.notify()
        }),
        Events.subscribe(map, "pointerleave", () => readout.textContent = "Key / Velocity"),
        Events.subscribe(waveform, "pointerdown", (event: PointerEvent) => {
            const marker = markerAt(event)
            if (!isDefined(marker) || event.button !== 0) {return}
            waveform.setPointerCapture(event.pointerId)
            markerDrag = marker.field
            markerMoved = false
        }),
        Events.subscribe(waveform, "pointermove", (event: PointerEvent) => {
            const zone = focused
            const field = markerDrag
            if (!isDefined(field) || !isDefined(zone)) {
                waveform.style.cursor = isDefined(markerAt(event)) ? "ew-resize" : ""
                return
            }
            const frames = framesOf(zone)
            if (!isDefined(frames)) {return}
            const {x, width} = pointerOf(waveform, event)
            const {sampleStart, sampleEnd, loopStart, loopEnd} = zone.box
            const end = Math.min(sampleEnd.getValue(), frames.numberOfFrames), loopTo = Math.min(loopEnd.getValue(), frames.numberOfFrames)
            const start = Math.min(sampleStart.getValue(), end)
            const low = field === sampleEnd ? start : field === loopEnd ? clamp(loopStart.getValue(), start, end)
                : field === loopStart ? start : 0
            const high = field === sampleStart ? end : field === loopStart ? Math.min(loopTo, end)
                : field === loopEnd ? end : frames.numberOfFrames
            const frame = clamp(Math.round(x / width * frames.numberOfFrames), low, high)
            if (frame === field.getValue()) {return}
            markerMoved = true
            editing.modify(() => field.setValue(frame), false)
        }),
        Events.subscribe(waveform, "pointerup", () => {
            if (isDefined(markerDrag) && markerMoved) {editing.mark()}
            markerDrag = undefined
        }),
        Events.subscribe(waveform, "pointercancel", () => {
            if (isDefined(markerDrag) && markerMoved) {editing.revertPending()}
            markerDrag = undefined
        }),
        Events.subscribe(keys, "pointerdown", (event: PointerEvent) => {
            keys.setPointerCapture(event.pointerId)
            play(event)
        }),
        Events.subscribe(keys, "pointermove", (event: PointerEvent) => {if (pressed !== -1) {play(event)}}),
        Events.subscribe(keys, "pointerup", release),
        Events.subscribe(keys, "pointercancel", release),
        {terminate: release}
    )
    readout.textContent = "Key / Velocity"
    update()
    const stackPanel: HTMLElement = (
        <div className="list stack">
            <h3>
                {stackTitle}
                {SamplerValueLabel.choice(lifecycle, observe, {names: RoundRobinNames, ...groupChoice(group => group.box.roundRobin)})}
            </h3>
            {stackList}
        </div>
    )
    const element: HTMLElement = (
        <div className={className}>
            <header>
                {presetName}
                {sampleCount}
                {readout}
                <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Removes the sample zones that were taken off the map"}}
                        onClick={() => {
                            editing.modify(() => SamplerZones.cleanUp(adapter.box))
                            refresh.notify()
                        }}><span>Clean Up</span></Button>
                <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Adds samples and maps them from their file names"}}
                        onClick={browse}><span>Add Samples</span></Button>
                <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Imports a soundfont preset, or an SFZ file chosen together with its samples"}}
                        onClick={async () => (await import("./SamplerImporter")).SamplerImporter.browse(service, adapter)}>
                    <span>Import SFZ / SF2</span>
                </Button>
                <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Saves this Sampler as a soundfont"}}
                        onClick={async () => (await import("./SamplerExporter")).SamplerExporter.save(service, adapter)}>
                    <span>Export SF2</span>
                </Button>
            </header>
            <div className="tools">
                <Button lifecycle={lifecycle} appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Selects every sample zone of the shown group"}}
                        onClick={() => {
                            select(shownZones().filter(zone => zone.box.enabled.getValue()))
                            refresh.notify()
                        }}><span>Select All</span></Button>
                {tool("Map by Name", "Reads note, dynamic and round robin from the file names (C4, pp to fff, v1, rr1) and maps the selected zones",
                    () => SamplerZones.mapByName(boxes()))}
                {tool("Spread Keys", "Extends each selected zone halfway to the neighbouring roots, so no key is left empty",
                    () => SamplerZones.spreadKeys(boxes()))}
                {tool("Spread Velocity", "Splits the velocity range evenly between the selected layers on the same keys",
                    () => SamplerZones.spreadVelocity(boxes()))}
                {tool("Crossfade", "Lets selected neighbours overlap and fade into each other, over keys and velocities",
                    () => SamplerZones.crossfade(boxes()))}
                {tool("Root to Low", "Sets the root key of each selected zone to its lowest key", () => SamplerZones.rootToLow(boxes()))}
                {tool("Duplicate", "Copies the selected zones onto the same keys, as further round robins",
                    () => {SamplerZones.duplicate(boxGraph, adapter.box, boxes())})}
                <MenuButton appearance={{color: Colors.shadow, activeColor: Colors.gray, tooltip: "Moves the selected zones into another group"}}
                            root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                ...adapter.groups.adapters().map(group => MenuItem.default({label: group.box.label.getValue()})
                                    .setTriggerProcedure(() => {
                                        editing.modify(() => SamplerZones.moveToGroup(boxes(), group.box))
                                        refresh.notify()
                                    }))))}>
                    <label><span>Move to Group</span><Icon symbol={IconSymbol.Dropdown}/></label>
                </MenuButton>
                {tool("Delete", "Takes the selected zones off the map, they stay in the list until Clean Up",
                    () => SamplerZones.disable(boxes()))}
                {tool("Restore", "Puts the selected zones back on the map", () => boxes().forEach(box => box.enabled.setValue(true)))}
                {selectionLabel}
            </div>
            {mapDisplay}
            <div className="keys">{keys}</div>
            <div className="side">
                <div className="list">
                    <h3>Groups</h3>
                    {groupList}
                </div>
                <div className="list">
                    <h3>Samples</h3>
                    {zoneList}
                </div>
                <SamplerModulationList lifecycle={lifecycle} editing={editing} adapter={adapter} onHover={voice.highlight}/>
            </div>
            <div className="inspector">
                <div className="focus">
                    {waveformDisplay}
                    {stackPanel}
                </div>
                <div className="stacks">
                    {SamplerStacks.stack("red", "Group", 1, [
                        choice("Stacks", RoundRobinNames, groupChoice(group => group.box.roundRobin)),
                        value(groupField("Choke", group => group.box.choke, 16, {
                            print: choke => choke === 0 ? ["Off", ""] : [String(choke), ""],
                            parse: text => /off/i.test(text) ? 0 : numberIn(text)
                        })),
                        choice("Trigger", TriggerNames, groupChoice(group => group.box.trigger))
                    ])}
                    {SamplerStacks.stack("orange", "Key", 1, [
                        value(zoneField("Low", box => box.keyLow, 0, MaxKey, 1, format.key,
                            box => {if (box.keyLow.getValue() > box.keyHigh.getValue()) {box.keyLow.setValue(box.keyHigh.getValue())}})),
                        value(zoneField("High", box => box.keyHigh, 0, MaxKey, 1, format.key,
                            box => {if (box.keyHigh.getValue() < box.keyLow.getValue()) {box.keyHigh.setValue(box.keyLow.getValue())}})),
                        value(zoneField("Fade", box => box.keyFade, 0, 24, 1, format.integer("st")))
                    ])}
                    {SamplerStacks.stack("yellow", "Velocity", 1, [
                        value(zoneField("Low", box => box.velocityLow, 1, 127, 1, format.integer(""),
                            box => {if (box.velocityLow.getValue() > box.velocityHigh.getValue()) {box.velocityLow.setValue(box.velocityHigh.getValue())}})),
                        value(zoneField("High", box => box.velocityHigh, 1, 127, 1, format.integer(""),
                            box => {if (box.velocityHigh.getValue() < box.velocityLow.getValue()) {box.velocityHigh.setValue(box.velocityLow.getValue())}})),
                        value(zoneField("Fade", box => box.velocityFade, 0, 64, 1, format.integer("")))
                    ])}
                    {SamplerStacks.stack("green", "Pitch", 1, [
                        value(zoneField("Root", box => box.rootKey, 0, MaxKey, 1, format.key)),
                        value(zoneField("Transp", box => box.transpose, -24, 24, 1, format.integer("st"))),
                        value(zoneField("Tune", box => box.tune, -100, 100, 1, format.integer("ct")))
                    ])}
                    {SamplerStacks.stack("blue", "Play", 2, [
                        value(zoneField("Gain", box => box.gain, -72, 12, 0.5, format.fixed(1, "dB"))),
                        value(zoneField("Pan", box => box.panning, -1, 1, 0.01, format.pan)),
                        value(zoneField("Track", box => box.keyTrack, 0, 1, 0.01, format.percent)),
                        value({
                            ...zoneField("Turn", box => box.sequence, 1, 128, 1, format.integer("")),
                            available: () => isDefined(focused) && robinMode() === RobinCycle,
                            spread: () => undefined,
                            set: turn => focused?.box.sequence.setValue(clamp(Math.round(turn), 1, 128))
                        }),
                        toggle("Reverse", box => box.reverse),
                        toggle("One Shot", box => box.oneShot)
                    ])}
                    {SamplerStacks.stack("purple", "Sample", 2, [
                        value(frameField("Start", box => box.sampleStart)),
                        value(frameField("End", box => box.sampleEnd)),
                        choice("Loop", LoopModeNames, {
                            available: () => isDefined(focused),
                            get: () => focused?.box.loopMode.getValue() ?? 0,
                            set: mode => editing.modify(() => selection.forEach(({box}) => box.loopMode.setValue(mode)))
                        }),
                        value(zoneField("Fade", box => box.loopFade, 0, 1, 0.005, format.seconds)),
                        value(frameField("From", box => box.loopStart)),
                        value(frameField("To", box => box.loopEnd))
                    ])}
                </div>
                <div className="stacks">{voice.stacks}</div>
            </div>
        </div>
    )
    lifecycle.own(SamplerSamples.installDrop(element, mapDisplay, service, dropped))
    return element
}
