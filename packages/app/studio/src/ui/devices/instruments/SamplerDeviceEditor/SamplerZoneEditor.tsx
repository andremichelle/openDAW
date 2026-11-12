import css from "./SamplerZoneEditor.sass?inline"
import {
    Arrays, clamp, Exec, int, isDefined, Lifecycle, Notifier, Nullable, Optional, Point, Procedure, RuntimeNotifier, Subscription,
    Terminator, UUID
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Files, Html, Keyboard} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {AudioInfo, MidiKeys} from "@opendaw/lib-dsp"
import {Int32Field} from "@opendaw/lib-box"
import {SamplerZoneBox} from "@opendaw/studio-boxes"
import {
    DeviceHost, NoteSignal, NoteStreamReceiver, Sample, SamplerDeviceBoxAdapter, SamplerGroupBoxAdapter, SamplerZoneBoxAdapter, SamplerZones
} from "@opendaw/studio-adapters"
import {CanvasPainter, FilePickerAcceptTypes, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Surface} from "@/ui/surface/Surface"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {ControlContext} from "../NanoDeviceEditor/ParameterControls"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {DragSample} from "@/ui/AnyDragData"
import {SamplerModulationList} from "./SamplerModulationList"
import {SamplerSamples} from "./SamplerSamples"
import {SamplerText} from "./SamplerText"
import {SamplerValueLabel} from "./SamplerValueLabel"
import {SamplerVoiceStacks} from "./SamplerVoiceStacks"
import {SamplerZoneMap} from "./SamplerZoneMap"
import {SamplerZoneTable} from "./SamplerZoneTable"

const className = Html.adoptStyleSheet(css, "SamplerZoneEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SamplerDeviceBoxAdapter
    deviceHost: DeviceHost
}

type Zone = SamplerZoneBoxAdapter

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
const MarkerReach = 6
const ClickReach = 3

const {numberIn} = SamplerValueLabel
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
    let tableZones: ReadonlyArray<Zone> = []
    let ownDrag = false
    // a menu gives the focus back to where it was before, so the window takes it after its own actions
    const takeFocus = (): void => queueMicrotask(() => element.focus({preventScroll: true}))
    let lastClick: Optional<Point> = undefined
    let band: Optional<Band> = undefined
    let rect: Optional<SamplerZoneMap.Range> = undefined
    let groupsSignature = ""
    const groupControls = lifecycle.own(new Terminator())
    const sampleControls = lifecycle.own(new Terminator())
    // a sample of the instrument as the sample browser hands one over, to drop it on the map again
    const sampleOf = (zone: Zone): Nullable<DragSample> => zone.file().mapOr(file => ({
        type: "sample",
        sample: {
            uuid: UUID.toString(file.uuid), name: file.box.fileName.getValue(), bpm: 0,
            duration: file.box.endInSeconds.getValue(),
            sample_rate: file.info.mapOr(info => info.sampleRate, 0), origin: "import"
        }
    }), null)
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
    const select = (zones: ReadonlyArray<Zone>, focus?: Zone, relist: boolean = true): void => {
        selection = zones
        lastClick = undefined
        focused = focus ?? (isDefined(focused) && zones.includes(focused) ? focused : zones.at(0))
        if (relist) {listRows()}
    }
    // cmd or ctrl adds the zones or takes them out again
    const toggleSelect = (zones: ReadonlyArray<Zone>): void => {
        if (zones.every(zone => selection.includes(zone))) {
            select(selection.filter(zone => !zones.includes(zone)))
        } else {
            select(union(selection, zones), zones[0])
        }
    }
    const hasModifier = (event: MouseEvent): boolean => event.shiftKey || event.metaKey || event.ctrlKey
    const boxes = (): ReadonlyArray<SamplerZoneBox> => selection.map(zone => zone.box)
    const framesOf = (zone: Zone): Optional<AudioInfo> =>
        zone.file().flatMap(file => file.info).unwrapOrUndefined()
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
            SamplerZones.createGroup(boxGraph, adapter.box, newGroupName()))}><Icon symbol={IconSymbol.Add}/></div>
    )
    const groupList: HTMLElement = <div className="rows"/>
    const zoneList: HTMLElement = <div className="rows"/>
    const waveformDisplay: HTMLElement = (
        <div className="display waveform">
            {waveform}
            {playheads}
            {sampleLabel}
        </div>
    )
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
        groupControls.terminate()
        const stop = (event: Event): void => event.stopPropagation()
        const pick = (group: SamplerGroupBoxAdapter, names: ReadonlyArray<string>, field: Int32Field): HTMLElement => (
            <span className="setting" onclick={stop} ondblclick={stop}>
                {SamplerValueLabel.choice(groupControls, observe, {
                    names, get: () => field.getValue(), set: index => editing.modify(() => field.setValue(index)),
                    available: () => group.box.isAttached()
                })}
            </span>
        )
        const choke = (group: SamplerGroupBoxAdapter): HTMLElement => (
            <span className="setting" onclick={stop} ondblclick={stop}>
                {SamplerValueLabel.create(groupControls, editing, observe, {
                    name: "Choke", min: 0, max: 16, step: 1,
                    print: value => value === 0 ? ["Off", ""] : [String(value), ""],
                    parse: text => /off/i.test(text) ? 0 : numberIn(text),
                    get: () => group.box.choke.getValue(), set: value => group.box.choke.setValue(Math.round(value)),
                    available: () => group.box.isAttached()
                })}
            </span>
        )
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
                {isDefined(group) ? pick(group, RoundRobinNames, group.box.roundRobin) : <span/>}
                {isDefined(group) ? choke(group) : <span/>}
                {isDefined(group) ? pick(group, TriggerNames, group.box.trigger) : <span/>}
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
            sampleControls.terminate()
            sampleRows = Array.from(samples, ([_, zones]) => [zones, (
                <div className={Html.buildClassList("row", zones.every(zone => !zone.box.enabled.getValue()) && "off")}
                     onInit={element => sampleControls.ownAll(
                         DragAndDrop.installSource(element, () => {
                             const sample = sampleOf(zones[0])
                             ownDrag = isDefined(sample)
                             return sample
                         }),
                         Events.subscribe(element, "dragend", () => ownDrag = false))}
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
    const turnOrder = (zone: Zone): ReadonlyArray<Zone> => SamplerZoneMap.robinsOf(state(), zone)
        .toSorted((left, right) => left.box.sequence.getValue() - right.box.sequence.getValue()
            || UUID.Comparator(left.uuid, right.uuid))
    // the rows are listed when the selection is made, so an edit neither reorders them nor drops one
    const listRows = (): void => {
        entries = SamplerZoneMap.entries(adapter)
        const shown = new Set(selection)
        if (isDefined(focused)) {turnOrder(focused).forEach(zone => shown.add(zone))}
        tableZones = Array.from(shown)
            .toSorted((left, right) => left.box.keyLow.getValue() - right.box.keyLow.getValue()
                || left.box.velocityLow.getValue() - right.box.velocityLow.getValue()
                || left.box.sequence.getValue() - right.box.sequence.getValue() || UUID.Comparator(left.uuid, right.uuid))
    }
    const tableRows = (): ReadonlyArray<Zone> => {
        tableZones = tableZones.filter(zone => zone.box.isAttached())
        return tableZones
    }
    // on the waveform a drop replaces the sample, on a range it joins, on the empty map it takes the key
    const dropped = (event: DragEvent): Procedure<ReadonlyArray<Sample>> => {
        const target = event.target
        const within = (element: HTMLElement): boolean => target instanceof Node && element.contains(target)
        const row = within(waveformDisplay) ? focused : undefined
        const onStack = isDefined(target) && within(zoneTable.element)
            ? zoneTable.zoneAt(target).unwrapOrUndefined() ?? focused : undefined
        const group = shownGroup?.box
        const {x, y, width, height} = pointerOf(map, event)
        const onMap = within(mapDisplay)
        // a sample of the instrument let go anywhere but on a place for it is a drag that was given up
        const own = ownDrag
        ownDrag = false
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
            if (own && !onMap && !isDefined(row) && !isDefined(onStack)) {return}
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
                    const whole = (zone: SamplerZoneBox): boolean => zone.velocityLow.getValue() === SamplerZoneMap.MinVelocity
                        && zone.velocityHigh.getValue() === SamplerZoneMap.MaxVelocity
                    created.filter(zone => zone.keyLow.getValue() === key && low <= high && whole(zone)).forEach(zone => {
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
        const {sampleStart, sampleEnd, loopStart, loopEnd, loopMode, oneShot} = zone.box
        const unit = (field: Int32Field): number => Math.min(field.getValue(), frames.numberOfFrames) / frames.numberOfFrames
        const start = unit(sampleStart), end = Math.max(start, unit(sampleEnd))
        const edges: ReadonlyArray<Marker> = [{field: sampleStart, unit: start}, {field: sampleEnd, unit: end}]
        if (loopMode.getValue() === 0 || oneShot.getValue()) {return edges}
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
        takeFocus()
        select(adapter.zones.adapters().filter(zone => created.includes(zone.box)))
        refresh.notify()
    }
    const browse = async (): Promise<void> => {
        const {status, value: files} = await Promises.tryCatch(Files.open({...FilePickerAcceptTypes.WavFiles, multiple: true}))
        if (status === "resolved") {added(SamplerSamples.add(project, adapter, shownGroup?.box, await SamplerSamples.importFiles(service, project, files)))}
    }
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
                    const anchor = focused
                    if (event.shiftKey && isDefined(anchor) && anchor.box.enabled.getValue() && !zones.includes(anchor)) {
                        const from = anchor.box, to = zones[0].box
                        select(SamplerZoneMap.within(state(), {
                            keyLow: Math.min(from.keyLow.getValue(), to.keyLow.getValue()),
                            keyHigh: Math.max(from.keyHigh.getValue(), to.keyHigh.getValue()),
                            velocityLow: Math.min(from.velocityLow.getValue(), to.velocityLow.getValue()),
                            velocityHigh: Math.max(from.velocityHigh.getValue(), to.velocityHigh.getValue())
                        }), anchor)
                        return
                    }
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
                const next = {
                    keyLow: Math.min(band.key, key), keyHigh: Math.max(band.key, key),
                    velocityLow: Math.min(band.velocity, velocity), velocityHigh: Math.max(band.velocity, velocity)
                }
                if (isDefined(rect) && next.keyLow === rect.keyLow && next.keyHigh === rect.keyHigh
                    && next.velocityLow === rect.velocityLow && next.velocityHigh === rect.velocityHigh) {return}
                rect = next
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
        Events.subscribe(map, "pointerleave", () => readout.textContent = ""),
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
    mapDisplay.appendChild(readout)
    update()
    const zoneTable = SamplerZoneTable.create(lifecycle, editing, observe, {
        rows: tableRows,
        selection: () => selection,
        focused: () => focused,
        select: (zones, focus) => {
            select(zones, focus, false)
            refresh.notify()
        },
        toggle: zone => {
            const kept = selection.includes(zone) ? selection.filter(other => other !== zone) : [...selection, zone]
            select(kept, selection.includes(zone) ? undefined : zone, false)
            refresh.notify()
        },
        remove: zone => {
            editing.modify(() => SamplerZones.disable([zone.box]))
            tableZones = tableZones.filter(other => other !== zone)
            select(selection.filter(other => other !== zone), undefined, false)
            refresh.notify()
        },
        framesOf,
        nameOf: zone => fileNameOf(zone).replace(/\.[A-Za-z0-9]+$/, "")
    })
    const act = (label: string, action: Exec, separatorBefore: boolean = false): MenuItem =>
        MenuItem.default({label, separatorBefore}).setTriggerProcedure(() => {
            editing.modify(action)
            refresh.notify()
            takeFocus()
        })
    const menu = MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
        MenuItem.default({label: "Add Samples..."}).setTriggerProcedure(browse),
        MenuItem.default({label: "Import SFZ / SF2..."})
            .setTriggerProcedure(async () => (await import("./SamplerImporter")).SamplerImporter.browse(service, adapter)),
        MenuItem.default({label: "Export SF2..."})
            .setTriggerProcedure(async () => (await import("./SamplerExporter")).SamplerExporter.save(service, adapter)),
        MenuItem.default({label: "Select All", separatorBefore: true}).setTriggerProcedure(() => {
            select(shownZones().filter(zone => zone.box.enabled.getValue()))
            refresh.notify()
            takeFocus()
        }),
        act("Map by Name", () => SamplerZones.mapByName(boxes()), true),
        act("Spread Keys", () => SamplerZones.spreadKeys(boxes())),
        act("Spread Velocity", () => SamplerZones.spreadVelocity(boxes())),
        act("Crossfade", () => SamplerZones.crossfade(boxes())),
        act("Root to Low", () => SamplerZones.rootToLow(boxes())),
        MenuItem.default({label: "Duplicate", separatorBefore: true}).setTriggerProcedure(() =>
            added(editing.modify(() => SamplerZones.duplicate(boxGraph, adapter.box, boxes())).unwrapOrElse(Arrays.empty()))),
        MenuItem.default({label: "Move to Group"}).setRuntimeChildrenProcedure(sub => sub.addMenuItem(
            ...adapter.groups.adapters().map(group => act(group.box.label.getValue(), () => SamplerZones.moveToGroup(boxes(), group.box))))),
        act("Delete", () => SamplerZones.disable(boxes())),
        act("Restore", () => boxes().forEach(box => box.enabled.setValue(true))),
        act("Delete Unused Samples", () => {SamplerZones.cleanUp(adapter.box)}, true)
    ))
    const element: HTMLElement = (
        <div className={className}>
            <header>
                <MenuButton root={menu} appearance={{color: Colors.shadow, activeColor: Colors.gray}}>
                    <label><span>Sample Zones</span><Icon symbol={IconSymbol.Dropdown}/></label>
                </MenuButton>
                {presetName}
                {sampleCount}
                {selectionLabel}
            </header>
            <div className="device">
                <div className="stacks">{voice.stacks}</div>
                <SamplerModulationList lifecycle={lifecycle} editing={editing} adapter={adapter} onHover={voice.highlight}/>
            </div>
            {mapDisplay}
            <div className="keys">{keys}</div>
            {zoneTable.element}
            <div className="side">
                <div className="list groups">
                    <h3><span>Groups</span><span>Zones</span><span>Stacks</span><span>Choke</span><span>Trigger</span><span/></h3>
                    {groupList}
                </div>
                <div className="list samples">
                    <h3>Samples</h3>
                    <div className="frame">{zoneList}</div>
                </div>
                {waveformDisplay}
            </div>
        </div>
    )
    element.tabIndex = -1
    requestAnimationFrame(takeFocus)
    lifecycle.ownAll(
        SamplerSamples.installDrop(element, mapDisplay, service, dropped),
        Events.subscribe(element, "keydown", (event: KeyboardEvent) => {
            if (!Keyboard.isDelete(event) || selection.length === 0 || Events.isTextInput(document.activeElement)) {return}
            event.preventDefault()
            event.stopPropagation()
            editing.modify(() => SamplerZones.disable(boxes()))
            select([])
            refresh.notify()
        })
    )
    return element
}
