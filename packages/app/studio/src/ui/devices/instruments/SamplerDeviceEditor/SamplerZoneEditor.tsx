import css from "./SamplerZoneEditor.sass?inline"
import {
    clamp, Exec, Func, int, isDefined, Lifecycle, MutableObservableValue, Notifier, ObservableValue, Observer, Optional, Procedure,
    Subscription, UUID
} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Files, Html} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {MidiKeys} from "@opendaw/lib-dsp"
import {BooleanField, Float32Field, Int32Field} from "@opendaw/lib-box"
import {AudioFileBox, SamplerZoneBox} from "@opendaw/studio-boxes"
import {
    DeviceHost, NoteSignal, Sample, SamplerDeviceBoxAdapter, SamplerGroupBoxAdapter, SamplerZoneBoxAdapter, SamplerZones
} from "@opendaw/studio-adapters"
import {CanvasPainter, FilePickerAcceptTypes, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {AnyDragData} from "@/ui/AnyDragData"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {ControlContext} from "../NanoDeviceEditor/ParameterControls"
import {SamplerModulationList} from "./SamplerModulationList"
import {SamplerStacks} from "./SamplerStacks"
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
const RoundRobinNames: ReadonlyArray<string> = ["Off", "Cycle", "Random"]
const TriggerNames: ReadonlyArray<string> = ["Attack", "Release"]
const LoopModeNames: ReadonlyArray<string> = ["Off", "On", "Always"]

const print = {
    integer: (unit: string): Func<number, SamplerValueLabel.Printed> => value => [String(Math.round(value)), unit],
    fixed: (digits: int, unit: string): Func<number, SamplerValueLabel.Printed> => value => [value.toFixed(digits), unit],
    percent: (value: number): SamplerValueLabel.Printed => [String(Math.round(value * 100)), "%"],
    key: (value: number): SamplerValueLabel.Printed => [MidiKeys.toFullString(Math.round(value)), ""],
    pan: (value: number): SamplerValueLabel.Printed =>
        Math.round(value * 100) === 0 ? ["C", ""] : [String(Math.abs(Math.round(value * 100))), value < 0 ? "L" : "R"],
    seconds: (value: number): SamplerValueLabel.Printed =>
        value < 1.0 ? [String(Math.round(value * 1000)), "ms"] : [value.toFixed(2), "s"],
    choice: (names: ReadonlyArray<string>): Func<number, SamplerValueLabel.Printed> => value => [names[Math.round(value)] ?? "", ""]
}

// The content of the sample zone window: the key × velocity map with its piano, the groups, sample zones and
// modulation slots, the focused zone's sample and fields, and every parameter of the device panel.
export const SamplerZoneEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning, boxGraph, engine} = project
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
    let band: Optional<Band> = undefined
    let rect: Optional<SamplerZoneMap.Range> = undefined
    let groupsSignature = ""
    let zonesSignature = ""
    let zoneRows: ReadonlyArray<[Zone, HTMLElement]> = []
    const state = (): SamplerZoneMap.State => ({
        entries, selection: new Set(selection), group: shownGroup?.indexField.getValue() ?? -1, pressed, rect
    })
    const shownZones = (): ReadonlyArray<Zone> => adapter.zones.adapters()
        .filter(zone => !isDefined(shownGroup) || zone.group().contains(shownGroup))
    const union = (first: ReadonlyArray<Zone>, second: ReadonlyArray<Zone>): ReadonlyArray<Zone> =>
        [...first, ...second.filter(zone => !first.includes(zone))]
    const select = (zones: ReadonlyArray<Zone>, focus?: Zone): void => {
        selection = zones
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
                       printer: Func<number, SamplerValueLabel.Printed>,
                       settle?: Procedure<SamplerZoneBox>): SamplerValueLabel.Field => ({
        name, min, max, step, print: printer,
        available: () => isDefined(focused),
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
                return isDefined(frames) ? print.seconds(unit * frames.numberOfFrames / frames.sampleRate) : SamplerValueLabel.Unavailable
            },
            available: () => isDefined(focused) && isDefined(framesOf(focused)),
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
    const currentGroup = (): Optional<SamplerGroupBoxAdapter> => shownGroup ?? focused?.group().unwrapOrUndefined()
    const groupField = (name: string, field: Func<SamplerGroupBoxAdapter, Int32Field>, max: number,
                        printer: Func<number, SamplerValueLabel.Printed>): SamplerValueLabel.Field => ({
        name, min: 0, max, step: 1, print: printer,
        available: () => isDefined(currentGroup()),
        get: () => {
            const group = currentGroup()
            return isDefined(group) ? field(group).getValue() : 0
        },
        set: value => {
            const group = currentGroup()
            if (isDefined(group)) {field(group).setValue(value)}
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
    const mapDisplay: HTMLElement = <div className="display map">{map}</div>
    const sampleLabel: HTMLElement = <span className="file-name"/>
    const presetName: HTMLElement = <span className="preset"/>
    const sampleCount: HTMLElement = <span className="samples"/>
    const selectionLabel: HTMLElement = <span className="count"/>
    const readout: HTMLElement = <span className="readout"/>
    const addGroup: HTMLElement = (
        <div className="add" onclick={() => editing.modify(() =>
            SamplerZones.createGroup(boxGraph, adapter.box, `Group ${adapter.groups.adapters().length + 1}`))}>Add</div>
    )
    const groupList: HTMLElement = <div className="rows"/>
    const zoneList: HTMLElement = <div className="rows"/>
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
                refresh.notify()
            }}>
                <i style={{backgroundColor: SamplerZoneMap.groupColor(group?.indexField.getValue() ?? -1).toString()}}/>
                <span>{name}</span>
                <span className="count">{String(count)}</span>
            </div>
        )
        groupList.replaceChildren(row(undefined, "All", zones.length),
            ...groups.map(group => row(group, group.box.label.getValue(), group.zones.adapters().length)), addGroup)
    }
    const updateZones = (): void => {
        const zones = shownZones()
        const signature = zones.map(zone => `${UUID.toString(zone.uuid)}/${fileNameOf(zone)}/${zone.box.enabled.getValue()}`).join("|")
        if (signature !== zonesSignature) {
            zonesSignature = signature
            zoneRows = zones.map(zone => [zone, (
                <div className={Html.buildClassList("row", !zone.box.enabled.getValue() && "off")} onclick={(event: MouseEvent) => {
                    const robins = SamplerZoneMap.robinsOf(state(), zone)
                    if (hasModifier(event)) {toggleSelect(robins)} else {select(robins, zone)}
                    refresh.notify()
                }}>
                    <span>{fileNameOf(zone).replace(/\.[A-Za-z0-9]+$/, "")}</span>
                </div>
            )])
            zoneList.replaceChildren(...zoneRows.map(([_, row]) => row))
        }
        zoneRows.forEach(([zone, row]) => {
            row.classList.toggle("active", zone === focused)
            row.classList.toggle("selected", selection.includes(zone))
        })
        const active = zoneRows.find(([zone]) => zone === focused)?.[1]
        if (isDefined(active) && !isDefined(drag) && !isDefined(band)) {
            if (active.offsetTop < zoneList.scrollTop + 8) {
                zoneList.scrollTop = active.offsetTop - 8
            } else if (active.offsetTop + active.offsetHeight > zoneList.scrollTop + zoneList.clientHeight - 8) {
                zoneList.scrollTop = active.offsetTop + active.offsetHeight - zoneList.clientHeight + 8
            }
        }
    }
    const updateLabels = (): void => {
        const zones = adapter.zones.adapters()
        const files = new Set(zones.map(zone => zone.file().unwrapOrUndefined()).filter(isDefined))
        const used = new Set(zones.filter(zone => zone.box.enabled.getValue()).map(zone => zone.file().unwrapOrUndefined()).filter(isDefined))
        presetName.textContent = adapter.labelField.getValue()
        sampleCount.textContent = `${files.size} samples, ${files.size - used.size} unused`
        selectionLabel.textContent = `${selection.length} of ${zones.length} sample zones selected`
        const zone = focused
        const robins = isDefined(zone) ? SamplerZoneMap.robinsOf(state(), zone) : []
        sampleLabel.textContent = !isDefined(zone) ? "No sample zone selected" : robins.length > 1
            ? `${fileNameOf(zone)} (round robin ${robins.indexOf(zone) + 1} of ${robins.length})` : fileNameOf(zone)
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
        watchLoaders()
        const attached = selection.filter(zone => zone.box.isAttached())
        if (attached.length !== selection.length) {select(attached)}
        if (isDefined(shownGroup) && !shownGroup.box.isAttached()) {shownGroup = undefined}
        updateGroups()
        updateZones()
        updateLabels()
        painters.forEach(painter => painter.requestUpdate())
    }
    const pointerOf = (canvas: HTMLCanvasElement, event: PointerEvent): { x: number, y: number, width: number, height: number } => {
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
    // new zones for the samples, in the shown group, mapped by what their names say
    const addZones = (samples: ReadonlyArray<Sample>): void => {
        if (samples.length === 0) {return}
        const created: Array<SamplerZoneBox> = []
        editing.modify(() => {
            const group = (shownGroup ?? adapter.groups.adapters().at(0))?.box
                ?? SamplerZones.createGroup(boxGraph, adapter.box, "Group 1")
            samples.forEach(sample => {
                const uuid = UUID.parse(sample.uuid)
                const file = boxGraph.findBox<AudioFileBox>(uuid).unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                    box.fileName.setValue(sample.name)
                    box.endInSeconds.setValue(sample.duration)
                }))
                created.push(SamplerZones.create(boxGraph, adapter.box, group, file))
            })
            SamplerZones.mapByName(created)
        })
        select(adapter.zones.adapters().filter(zone => created.includes(zone.box)))
        refresh.notify()
    }
    const importFiles = async (files: ReadonlyArray<File>): Promise<void> => {
        const imported = await service.sampleService.importFiles(files)
        imported.forEach(sample => project.trackUserCreatedSample(UUID.parse(sample.uuid)))
        addZones(imported)
    }
    const browse = async (): Promise<void> => {
        const {status, value: files} = await Promises.tryCatch(Files.open({...FilePickerAcceptTypes.WavFiles, multiple: true}))
        if (status === "resolved") {await importFiles(files)}
    }
    const tool = (label: string, tooltip: string, action: Exec): JsxValue => (
        <Button lifecycle={lifecycle} appearance={{framed: true, color: Colors.shadow, tooltip}} onClick={() => {
            editing.modify(action)
            refresh.notify()
        }}><span>{label}</span></Button>
    )
    const context: ControlContext = {lifecycle, editing, midiLearning, deviceHost}
    const voice = SamplerVoiceStacks.create(context, adapter)
    lifecycle.ownAll(
        ...painters,
        refresh.subscribe(update),
        boxGraph.subscribeToAllUpdates({onUpdate: schedule}),
        adapter.labelField.subscribe(schedule),
        Events.subscribe(map, "pointerdown", (event: PointerEvent) => {
            const {x, y, width, height} = pointerOf(map, event)
            const key = SamplerZoneMap.keyAt(x, width)
            const velocity = SamplerZoneMap.velocityAt(y, height)
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
                    const collapse = selection.includes(zones[0]) && selection.length > zones.length
                    if (!selection.includes(zones[0])) {select(zones)} else {focused = zones[0]}
                    dragMoved = false
                    drag = {
                        edge, key, velocity, collapse: collapse ? zones : undefined,
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
                if (key === drag.key && velocity === drag.velocity && !dragMoved) {return}
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
                if (dragMoved) {editing.mark()} else if (isDefined(drag.collapse)) {select(drag.collapse)}
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
            refresh.notify()
        }),
        Events.subscribe(map, "pointerleave", () => readout.textContent = "Key / Velocity"),
        Events.subscribe(keys, "pointerdown", (event: PointerEvent) => {
            keys.setPointerCapture(event.pointerId)
            play(event)
        }),
        Events.subscribe(keys, "pointermove", (event: PointerEvent) => {if (pressed !== -1) {play(event)}}),
        Events.subscribe(keys, "pointerup", release),
        Events.subscribe(keys, "pointercancel", release),
        DragAndDrop.installTarget(mapDisplay, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => data.type === "sample" || data.type === "file",
            drop: async (_event: DragEvent, data: AnyDragData): Promise<void> => {
                if (data.type === "sample") {addZones([data.sample])} else if (data.type === "file") {await importFiles(data.files)}
            },
            enter: (allowDrop: boolean) => mapDisplay.classList.toggle("accept", allowDrop),
            leave: () => mapDisplay.classList.remove("accept")
        }),
        {terminate: release}
    )
    readout.textContent = "Key / Velocity"
    update()
    return (
        <div className={className}>
            <header>
                {presetName}
                {sampleCount}
                {readout}
                <Button lifecycle={lifecycle} appearance={{framed: true, color: Colors.shadow, tooltip: "Removes the sample zones that were taken off the map"}}
                        onClick={() => {
                            editing.modify(() => SamplerZones.cleanUp(adapter.box))
                            refresh.notify()
                        }}><span>Clean Up</span></Button>
                <Button lifecycle={lifecycle} appearance={{framed: true, color: Colors.shadow, tooltip: "Adds samples and maps them from their file names"}}
                        onClick={browse}><span>Add Samples</span></Button>
            </header>
            <div className="tools">
                <Button lifecycle={lifecycle} appearance={{framed: true, color: Colors.shadow, tooltip: "Selects every sample zone of the shown group"}}
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
                <MenuButton appearance={{framed: true, color: Colors.shadow, tooltip: "Moves the selected zones into another group"}}
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
                    <h3>Sample Zones</h3>
                    {zoneList}
                </div>
                <SamplerModulationList lifecycle={lifecycle} editing={editing} adapter={adapter} onHover={voice.highlight}/>
            </div>
            <div className="inspector">
                <div className="display waveform">
                    {waveform}
                    {sampleLabel}
                </div>
                <div className="stacks">
                    {SamplerStacks.stack("orange", "Group", 1, [
                        value(groupField("Robin", group => group.box.roundRobin, 2, print.choice(RoundRobinNames))),
                        value(groupField("Choke", group => group.box.choke, 16, choke => choke === 0 ? ["Off", ""] : [String(choke), ""])),
                        value(groupField("Trigger", group => group.box.trigger, 1, print.choice(TriggerNames)))
                    ])}
                    {SamplerStacks.stack("yellow", "Key", 1, [
                        value(zoneField("Low", box => box.keyLow, 0, MaxKey, 1, print.key,
                            box => {if (box.keyLow.getValue() > box.keyHigh.getValue()) {box.keyLow.setValue(box.keyHigh.getValue())}})),
                        value(zoneField("High", box => box.keyHigh, 0, MaxKey, 1, print.key,
                            box => {if (box.keyHigh.getValue() < box.keyLow.getValue()) {box.keyHigh.setValue(box.keyLow.getValue())}})),
                        value(zoneField("Fade", box => box.keyFade, 0, 24, 1, print.integer("st")))
                    ])}
                    {SamplerStacks.stack("green", "Velocity", 1, [
                        value(zoneField("Low", box => box.velocityLow, 1, 127, 1, print.integer(""),
                            box => {if (box.velocityLow.getValue() > box.velocityHigh.getValue()) {box.velocityLow.setValue(box.velocityHigh.getValue())}})),
                        value(zoneField("High", box => box.velocityHigh, 1, 127, 1, print.integer(""),
                            box => {if (box.velocityHigh.getValue() < box.velocityLow.getValue()) {box.velocityHigh.setValue(box.velocityLow.getValue())}})),
                        value(zoneField("Fade", box => box.velocityFade, 0, 64, 1, print.integer("")))
                    ])}
                    {SamplerStacks.stack("blue", "Pitch", 1, [
                        value(zoneField("Root", box => box.rootKey, 0, MaxKey, 1, print.key)),
                        value(zoneField("Transp", box => box.transpose, -24, 24, 1, print.integer("st"))),
                        value(zoneField("Tune", box => box.tune, -100, 100, 1, print.integer("ct")))
                    ])}
                    {SamplerStacks.stack("purple", "Play", 2, [
                        value(zoneField("Gain", box => box.gain, -72, 12, 0.5, print.fixed(1, "dB"))),
                        value(zoneField("Pan", box => box.panning, -1, 1, 0.01, print.pan)),
                        value(zoneField("Track", box => box.keyTrack, 0, 1, 0.01, print.percent)),
                        value(zoneField("Seq", box => box.sequence, 1, 128, 1, print.integer(""))),
                        toggle("Reverse", box => box.reverse),
                        toggle("One Shot", box => box.oneShot)
                    ])}
                    {SamplerStacks.stack("cream", "Sample", 2, [
                        value(frameField("Start", box => box.sampleStart)),
                        value(frameField("End", box => box.sampleEnd)),
                        value(zoneField("Loop", box => box.loopMode, 0, 2, 1, print.choice(LoopModeNames))),
                        value(zoneField("Fade", box => box.loopFade, 0, 1, 0.005, print.seconds)),
                        value(frameField("From", box => box.loopStart)),
                        value(frameField("To", box => box.loopEnd))
                    ])}
                </div>
                <div className="stacks">{voice.stacks}</div>
            </div>
        </div>
    )
}
