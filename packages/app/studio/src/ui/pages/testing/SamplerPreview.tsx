import css from "./SamplerPreview.sass?inline"
import {clamp, DefaultObservableValue, Exec, Func, int, isDefined, Lifecycle, Notifier, Optional} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {MidiKeys} from "@opendaw/lib-dsp"
import {CanvasPainter, MenuItem} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {DropDown} from "@/ui/composite/DropDown"
import {SamplerModel} from "@/ui/pages/testing/sampler/SamplerModel"
import {SamplerControls} from "@/ui/pages/testing/sampler/SamplerControls"
import {ZoneMap} from "@/ui/pages/testing/sampler/ZoneMap"

const className = Html.adoptStyleSheet(css, "SamplerPreview")

type Construct = {
    lifecycle: Lifecycle
}

type Origin = {
    readonly zone: SamplerModel.Zone
    readonly keyLo: int
    readonly keyHi: int
    readonly velLo: int
    readonly velHi: int
    readonly rootKey: int
}

type Drag = {
    readonly edge: ZoneMap.Edge
    readonly key: int
    readonly velocity: int
    readonly origins: ReadonlyArray<Origin>
    readonly collapse: Optional<ReadonlyArray<SamplerModel.Zone>>
}

type Band = {
    readonly key: int
    readonly velocity: int
    readonly keep: ReadonlyArray<SamplerModel.Zone>
}

const Cursors: Readonly<Record<ZoneMap.Edge, string>> =
    {move: "", left: "ew-resize", right: "ew-resize", top: "ns-resize", bottom: "ns-resize"}
const PlayVelocity: int = 100
const Dynamics: ReadonlyArray<string> = ["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]
const Sources: ReadonlyArray<string> = ["Amp Env", "Mod Env", "LFO 1", "LFO 2", "Velocity", "Key", "Random"]
const Targets: ReadonlyArray<string> =
    ["Pitch", "Cutoff", "Reso", "Gain", "Pan", "Start", "Loop", "LFO 1 Rate", "LFO 2 Rate", "Env Depth"]

export const SamplerPreview = ({lifecycle}: Construct) => {
    const {Print, local, stack, tabbed} = SamplerControls
    const instruments = SamplerModel.create()
    const instrumentIndex = lifecycle.own(new DefaultObservableValue<int>(0))
    const refresh = lifecycle.own(new Notifier<void>())
    let selection: ReadonlyArray<SamplerModel.Zone> = []
    let focused: Optional<SamplerModel.Zone> = undefined
    let dragMoved: boolean = false
    let group: int = -1
    let pressed: int = -1
    let drag: Optional<Drag> = undefined
    let band: Optional<Band> = undefined
    let rect: Optional<ZoneMap.Range> = undefined
    const instrument = (): SamplerModel.Instrument => instruments[instrumentIndex.getValue()]
    const state = (): ZoneMap.State => ({instrument: instrument(), selection: new Set(selection), group, pressed, rect})
    const visibleZones = (): ReadonlyArray<SamplerModel.Zone> =>
        instrument().zones.filter(zone => group === -1 || zone.group === group)
    const robinsOf = (zone: SamplerModel.Zone): ReadonlyArray<SamplerModel.Zone> =>
        instrument().zones.filter(other => ZoneMap.sameRange(other, zone))
    const union = (first: ReadonlyArray<SamplerModel.Zone>, second: ReadonlyArray<SamplerModel.Zone>) =>
        [...first, ...second.filter(zone => !first.includes(zone))]
    const select = (zones: ReadonlyArray<SamplerModel.Zone>, focus?: SamplerModel.Zone): void => {
        selection = zones
        focused = focus ?? (isDefined(focused) && zones.includes(focused) ? focused : zones.at(0))
    }
    // shift, cmd or ctrl adds the zones or takes them out again
    const toggleSelect = (zones: ReadonlyArray<SamplerModel.Zone>): void => {
        if (zones.every(zone => selection.includes(zone))) {
            select(selection.filter(zone => !zones.includes(zone)))
        } else {
            select(union(selection, zones), zones[0])
        }
    }
    const hasModifier = (event: MouseEvent): boolean => event.shiftKey || event.metaKey || event.ctrlKey
    const zonesAt = (key: int, velocity: int): ReadonlyArray<SamplerModel.Zone> => {
        const matches = visibleZones().filter(zone =>
            key >= zone.keyLo && key <= zone.keyHi && velocity >= zone.velLo && velocity <= zone.velHi)
        return matches.filter(zone => zone.group === matches[0].group)
    }
    const selectDefault = (): void => {
        const zones = visibleZones()
        const center = zones.reduce((best, zone) =>
            Math.abs(zone.rootKey - 60) < Math.abs(best.rootKey - 60) ? zone : best, zones[0])
        select(robinsOf(center), center)
    }
    const currentGroup = (): Optional<SamplerModel.Group> =>
        group !== -1 ? instrument().groups[group] : isDefined(focused) ? instrument().groups[focused.group] : undefined
    const zoneField = (name: string, key: SamplerModel.ZoneKey, min: number, max: number, step: number,
                       print: Func<number, SamplerControls.Printed>, toggle?: boolean): SamplerControls.Field => ({
        name, min, max, step, print, toggle,
        available: () => isDefined(focused),
        get: () => focused?.[key] ?? 0,
        set: value => {
            if (!isDefined(focused)) {return}
            const delta = value - focused[key]
            selection.forEach(zone => {
                zone[key] = clamp(zone[key] + delta, min, max)
                if (zone.keyLo > zone.keyHi) {
                    if (key === "keyLo") {zone.keyLo = zone.keyHi} else {zone.keyHi = zone.keyLo}
                }
                if (zone.velLo > zone.velHi) {
                    if (key === "velLo") {zone.velLo = zone.velHi} else {zone.velHi = zone.velLo}
                }
            })
        }
    })
    const groupField = (name: string, key: SamplerModel.GroupKey, min: number, max: number, step: number,
                        print: Func<number, SamplerControls.Printed>): SamplerControls.Field => ({
        name, min, max, step, print,
        available: () => isDefined(currentGroup()),
        get: () => currentGroup()?.[key] ?? 0,
        set: value => {
            const target = currentGroup()
            if (isDefined(target)) {target[key] = value}
        }
    })
    const envelope = (attack: number, decay: number, sustain: number): ReadonlyArray<SamplerControls.Field> => [
        local("Delay", 0, 0, 2, 0.01, Print.seconds),
        local("Attack", attack, 0.001, 5, 0.005, Print.seconds),
        local("Hold", 0, 0, 2, 0.01, Print.seconds),
        local("Decay", decay, 0.001, 8, 0.02, Print.seconds),
        local("Sustain", sustain, 0, 1, 0.01, Print.percent),
        local("Release", 0.25, 0.001, 8, 0.01, Print.seconds)
    ]
    const oscillator = (rate: number): ReadonlyArray<SamplerControls.Field> => [
        local("Shape", 0, 0, 3, 1, Print.choice(["Sine", "Tri", "Saw", "Square"])),
        local("Rate", rate, 0.05, 30, 0.05, Print.fixed(2, "Hz")),
        local("Delay", 0.3, 0, 4, 0.01, Print.seconds),
        local("Fade", 0.2, 0, 4, 0.01, Print.seconds),
        local("Sync", 0, 0, 1, 1, Print.integer(""), true),
        local("Restart", 1, 0, 1, 1, Print.integer(""), true)
    ]
    const tune = local("Tune", 0, -100, 100, 1, Print.integer("ct"))
    const cutoff = local("Cutoff", 12000, 20, 20000, 100, Print.hertz)
    const resonance = local("Reso", 0.1, 0, 1, 0.01, Print.percent)
    const volume = local("Volume", -3, -72, 12, 0.1, Print.fixed(1, "dB"))
    const panning = local("Pan", 0, -1, 1, 0.01, Print.pan)
    const lfo1 = oscillator(5.5)
    const lfo2 = oscillator(0.5)
    const ampEnvelope = envelope(0.003, 0.6, 1)
    const modEnvelope = envelope(0.001, 0.4, 0)
    const playFields = [
        local("Voices", 16, 1, 64, 1, Print.integer("")),
        local("Transp", 0, -24, 24, 1, Print.integer("st")),
        local("Glide", 0, 0, 2, 0.01, Print.seconds),
        tune,
        local("Legato", 0, 0, 1, 1, Print.integer(""), true),
        local("Bend", 2, 0, 24, 1, Print.integer("st"))
    ]
    const filter = [local("Type", 1, 0, 3, 1, Print.choice(["Off", "LP 12", "LP 24", "HP 12"])), cutoff, resonance]
    const mix = [volume, panning, local("Mono", 0, 0, 1, 0.01, Print.percent)]
    const sourceTabs: ReadonlyArray<Array<HTMLElement>> = Sources.map(() => [])
    const targetFields: ReadonlyArray<Optional<SamplerControls.Field>> =
        [tune, cutoff, resonance, volume, panning, undefined, undefined, lfo1[1], lfo2[1]]
    const voiceStacks = (): ReadonlyArray<HTMLElement> => {
        const envelopes = tabbed(lifecycle, refresh, "blue", 2,
            [{name: "Amp Envelope", fields: ampEnvelope}, {name: "Mod Envelope", fields: modEnvelope}])
        const oscillators = tabbed(lifecycle, refresh, "purple", 2, [{name: "LFO 1", fields: lfo1}, {name: "LFO 2", fields: lfo2}])
        const tabs = [...envelopes.tabs, ...oscillators.tabs]
        tabs.forEach((tab, index) => sourceTabs[index].push(tab))
        return [
            stack(lifecycle, refresh, "orange", "Play", 2, playFields),
            stack(lifecycle, refresh, "yellow", "Filter", 1, filter),
            stack(lifecycle, refresh, "green", "Mix", 1, mix),
            envelopes.element,
            oscillators.element
        ]
    }
    const slotLists: Array<HTMLElement> = []
    const modulation = (): HTMLElement => {
        const add: HTMLElement = <div className="add" onclick={() => createSlot(0, 0, 0)}>Add</div>
        const list: HTMLElement = <div className="rows">{add}</div>
        slotLists.push(list)
        return (
            <div className="modulation">
                <div className="label">Source</div>
                <div className="label">Target</div>
                <div className="label">Amount</div>
                {list}
            </div>
        )
    }
    const createSlot = (source: int, target: int, amount: number): void => {
        const sourceModel = lifecycle.own(new DefaultObservableValue<int>(source))
        const targetModel = lifecycle.own(new DefaultObservableValue<int>(target))
        const field = local("", amount, -1, 1, 0.01, value =>
            targetModel.getValue() === 0 ? [String(Math.round(value * 1200)), "ct"] : Print.percent(value))
        const highlight = (enabled: boolean): void => {
            sourceTabs[sourceModel.getValue()].forEach(tab => tab.classList.toggle("highlight", enabled))
            const targetField = targetFields[targetModel.getValue()]
            if (isDefined(targetField)) {SamplerControls.highlight(targetField, enabled)}
        }
        const chooser = (model: DefaultObservableValue<int>, names: ReadonlyArray<string>) => (
            <DropDown lifecycle={lifecycle} owner={model} provider={() => names.map((_, index) => index)}
                      mapping={index => names[index]} appearance={{color: Colors.dark, activeColor: Colors.gray}}/>
        )
        const rows: ReadonlyArray<HTMLElement> = slotLists.map(list => {
            const row: HTMLElement = (
                <div className="slot" onpointerenter={() => highlight(true)} onpointerleave={() => highlight(false)}>
                    {chooser(sourceModel, Sources)}
                    {chooser(targetModel, Targets)}
                    {SamplerControls.value(lifecycle, refresh, field)}
                    <div className="remove" onclick={() => {
                        highlight(false)
                        rows.forEach(other => other.remove())
                    }}><Icon symbol={IconSymbol.Close}/></div>
                </div>
            )
            list.insertBefore(row, list.lastElementChild)
            return row
        })
        lifecycle.own(targetModel.subscribe(() => refresh.notify()))
    }
    const panelStacks = voiceStacks()
    const panelModulation = modulation()
    const windowStacks = voiceStacks()
    const windowModulation = modulation()
    createSlot(4, 3, 0.8)
    createSlot(1, 1, 0.3)
    createSlot(4, 1, 0.4)
    createSlot(5, 1, 0.5)
    createSlot(2, 0, 0.01)
    const map: HTMLCanvasElement = <canvas/>
    const keys: HTMLCanvasElement = <canvas/>
    const waveform: HTMLCanvasElement = <canvas/>
    const sampleLabel: HTMLElement = <span className="file-name"/>
    const windowName: HTMLElement = <span className="preset"/>
    const sampleCount: HTMLElement = <span className="samples"/>
    const selectionLabel: HTMLElement = <span className="count"/>
    const readout: HTMLElement = <span className="readout"/>
    const groupList: HTMLElement = <div className="rows"/>
    const zoneList: HTMLElement = <div className="rows"/>
    let zoneRows: ReadonlyArray<[SamplerModel.Zone, HTMLElement]> = []
    const painters: ReadonlyArray<CanvasPainter> = [
        new CanvasPainter(map, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            ZoneMap.paint(context, actualWidth, actualHeight, devicePixelRatio, state())),
        new CanvasPainter(keys, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            ZoneMap.paintKeyboard(context, actualWidth, actualHeight, devicePixelRatio, true, state())),
        new CanvasPainter(waveform, ({context, actualWidth, actualHeight, devicePixelRatio}) =>
            ZoneMap.paintWaveform(context, actualWidth, actualHeight, devicePixelRatio, focused))
    ]
    const updateZones = (): void => {
        zoneRows = visibleZones().map(zone => [zone, (
            <div className="row" onclick={(event: MouseEvent) => {
                if (hasModifier(event)) {toggleSelect(robinsOf(zone))} else {select(robinsOf(zone), zone)}
                refresh.notify()
            }}>
                <span>{zone.name.replace(".wav", "")}</span>
            </div>
        )])
        zoneList.replaceChildren(...zoneRows.map(([_, row]) => row))
    }
    const updateGroups = (): void => {
        const {groups, zones} = instrument()
        const row = (index: int, name: string, count: int, color: string): HTMLElement => (
            <div className={Html.buildClassList("row", index === group && "active")} onclick={() => {
                group = index
                if (index !== -1 && focused?.group !== index) {selectDefault()}
                updateGroups()
                updateZones()
                refresh.notify()
            }}>
                <i style={{backgroundColor: color}}/>
                <span>{name}</span>
                <span className="count">{String(count)}</span>
            </div>
        )
        groupList.replaceChildren(row(-1, "All", zones.length, Colors.shadow.toString()),
            ...groups.map((entry, index) =>
                row(index, entry.name, zones.filter(zone => zone.group === index).length, entry.color.toString())))
    }
    const updateLabels = (): void => {
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
        const zone = focused
        const robins = isDefined(zone) ? robinsOf(zone) : []
        sampleLabel.textContent = !isDefined(zone) ? "No sample zone selected" : robins.length > 1
            ? `${zone.name} (round robin ${robins.indexOf(zone) + 1} of ${robins.length})` : zone.name
        windowName.textContent = instrument().name
        sampleCount.textContent = `${instrument().samples.length} samples, ${unusedSamples().length} unused`
        selectionLabel.textContent = `${selection.length} of ${instrument().zones.length} sample zones selected`
    }
    const pointerOf = (canvas: HTMLCanvasElement, event: PointerEvent): { x: number, y: number, width: number, height: number } => {
        const {left, top, width, height} = canvas.getBoundingClientRect()
        return {x: event.clientX - left, y: event.clientY - top, width, height}
    }
    const applyDrag = ({edge, key, velocity, origins}: Drag, toKey: int, toVelocity: int): void => {
        const keyDelta = edge === "move"
            ? clamp(toKey - key, -Math.min(...origins.map(origin => origin.keyLo)),
                ZoneMap.NumKeys - 1 - Math.max(...origins.map(origin => origin.keyHi))) : toKey - key
        const velocityDelta = edge === "move"
            ? clamp(toVelocity - velocity, 1 - Math.min(...origins.map(origin => origin.velLo)),
                ZoneMap.MaxVelocity - Math.max(...origins.map(origin => origin.velHi))) : toVelocity - velocity
        origins.forEach(({zone, keyLo, keyHi, velLo, velHi, rootKey}) => {
            if (edge === "move") {
                zone.keyLo = keyLo + keyDelta
                zone.keyHi = keyHi + keyDelta
                zone.rootKey = clamp(rootKey + keyDelta, 0, ZoneMap.NumKeys - 1)
                zone.velLo = velLo + velocityDelta
                zone.velHi = velHi + velocityDelta
            } else if (edge === "left") {
                zone.keyLo = clamp(keyLo + keyDelta, 0, keyHi)
            } else if (edge === "right") {
                zone.keyHi = clamp(keyHi + keyDelta, keyLo, ZoneMap.NumKeys - 1)
            } else if (edge === "top") {
                zone.velHi = clamp(velHi + velocityDelta, velLo, ZoneMap.MaxVelocity)
            } else {
                zone.velLo = clamp(velLo + velocityDelta, 1, velHi)
            }
        })
    }
    const play = (event: PointerEvent): void => {
        const {x, y, width, height} = pointerOf(keys, event)
        const key = ZoneMap.keyboardKeyAt(x, y, width, height)
        if (key === pressed) {return}
        pressed = key
        const matches = zonesAt(key, PlayVelocity)
        if (matches.length > 0) {
            select(matches, matches[((isDefined(focused) ? matches.indexOf(focused) : -1) + 1) % matches.length])
        }
        refresh.notify()
    }
    // each selected zone reaches halfway to the neighbouring roots
    const spreadKeys = (): void => {
        const roots = [...new Set(selection.map(zone => zone.rootKey))].sort((a, b) => a - b)
        selection.forEach(zone => {
            const index = roots.indexOf(zone.rootKey)
            if (index > 0) {zone.keyLo = Math.floor((roots[index - 1] + zone.rootKey) / 2) + 1}
            if (index < roots.length - 1) {zone.keyHi = Math.floor((zone.rootKey + roots[index + 1]) / 2)}
        })
    }
    // the selected layers on the same keys share the velocity range evenly
    const spreadVelocity = (): void => {
        const columnOf = (zone: SamplerModel.Zone): string => `${zone.group}/${zone.keyLo}/${zone.keyHi}`
        const layers = new Map<string, Array<int>>()
        selection.forEach(zone => {
            const column = layers.get(columnOf(zone)) ?? []
            if (!column.includes(zone.velLo)) {column.push(zone.velLo)}
            layers.set(columnOf(zone), column.sort((a, b) => a - b))
        })
        const targets = selection.map(zone => {
            const column = layers.get(columnOf(zone)) ?? []
            const index = column.indexOf(zone.velLo)
            return [index === 0 ? 1 : Math.round(index * 127 / column.length) + 1,
                Math.round((index + 1) * 127 / column.length)]
        })
        selection.forEach((zone, index) => [zone.velLo, zone.velHi] = targets[index])
    }
    const remove = (): void => {
        const {zones} = instrument()
        const remaining = zones.filter(zone => !selection.includes(zone))
        if (remaining.length === 0) {return}
        zones.splice(0, zones.length, ...remaining)
        if (visibleZones().length === 0) {group = -1}
        select([])
        updateGroups()
    }
    const mapByName = (): void => {
        selection.forEach(zone => {
            const match = /_([A-G]#?)(-?\d)[_.]/.exec(zone.name)
            if (!isDefined(match)) {return}
            const root = MidiKeys.Names.English.indexOf(match[1]) + (parseInt(match[2]) + 2) * 12
            zone.rootKey = zone.keyLo = zone.keyHi = root
            const dynamic = /_(ppp|pp|p|mp|mf|f|ff|fff)[_.]/.exec(zone.name)
            if (isDefined(dynamic)) {zone.velLo = zone.velHi = Dynamics.indexOf(dynamic[1]) + 1}
        })
        spreadKeys()
        spreadVelocity()
    }
    // neighbours among the selection reach into each other and fade over the overlap
    const crossfade = (): void => {
        const touches = (zone: SamplerModel.Zone, other: SamplerModel.Zone): boolean => other.group === zone.group
        const changes = selection.map(zone => {
            const besides = selection.filter(other => touches(zone, other)
                && other.velLo <= zone.velHi && other.velHi >= zone.velLo)
            const stacked = selection.filter(other => touches(zone, other)
                && other.keyLo <= zone.keyHi && other.keyHi >= zone.keyLo)
            return {
                zone,
                keyLo: zone.keyFade === 0 && besides.some(other => other.keyHi === zone.keyLo - 1) ? zone.keyLo - 1 : zone.keyLo,
                keyHi: zone.keyFade === 0 && besides.some(other => other.keyLo === zone.keyHi + 1) ? zone.keyHi + 1 : zone.keyHi,
                velLo: zone.velFade === 0 && stacked.some(other => other.velHi === zone.velLo - 1) ? zone.velLo - 4 : zone.velLo,
                velHi: zone.velFade === 0 && stacked.some(other => other.velLo === zone.velHi + 1) ? zone.velHi + 4 : zone.velHi
            }
        })
        changes.forEach(({zone, keyLo, keyHi, velLo, velHi}) => {
            if (keyLo !== zone.keyLo || keyHi !== zone.keyHi) {zone.keyFade = 2}
            if (velLo !== zone.velLo || velHi !== zone.velHi) {zone.velFade = 8}
            zone.keyLo = keyLo
            zone.keyHi = keyHi
            zone.velLo = Math.max(1, velLo)
            zone.velHi = Math.min(ZoneMap.MaxVelocity, velHi)
        })
    }
    const unusedSamples = (): ReadonlyArray<string> => {
        const {samples, zones} = instrument()
        return samples.filter(sample => !zones.some(zone => zone.name === sample))
    }
    const cleanUp = (): void => {
        const {samples} = instrument()
        const unused = unusedSamples()
        samples.splice(0, samples.length, ...samples.filter(sample => !unused.includes(sample)))
    }
    const duplicate = (): void => {
        const copies = selection.map(zone => ({...zone, sequence: robinsOf(zone).length + 1}))
        instrument().zones.push(...copies)
        select(copies)
        updateGroups()
    }
    const moveToGroup = (index: int): void => {
        selection.forEach(zone => zone.group = index)
        if (group !== -1) {group = index}
        updateGroups()
        updateZones()
        refresh.notify()
    }
    const tool = (label: string, tooltip: string, action: Exec): HTMLElement => (
        <Button lifecycle={lifecycle} appearance={{framed: true, color: Colors.shadow, tooltip}} onClick={() => {
            action()
            updateZones()
            refresh.notify()
        }}><span>{label}</span></Button>
    )
    lifecycle.ownAll(
        ...painters,
        refresh.subscribe(() => {
            painters.forEach(painter => painter.requestUpdate())
            updateLabels()
        }),
        instrumentIndex.subscribe(() => {
            group = -1
            selectDefault()
            updateGroups()
            updateZones()
            refresh.notify()
        }),
        Events.subscribe(map, "pointerdown", (event: PointerEvent) => {
            const {x, y, width, height} = pointerOf(map, event)
            const key = ZoneMap.keyAt(x, width)
            const velocity = ZoneMap.velocityAt(y, height)
            map.setPointerCapture(event.pointerId)
            ZoneMap.hit(state(), x, y, width, height, 5).match({
                none: () => {
                    band = {key, velocity, keep: hasModifier(event) ? selection : []}
                    rect = {keyLo: key, keyHi: key, velLo: velocity, velHi: velocity}
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
                            zone, keyLo: zone.keyLo, keyHi: zone.keyHi, velLo: zone.velLo, velHi: zone.velHi,
                            rootKey: zone.rootKey
                        }))
                    }
                }
            })
            refresh.notify()
        }),
        Events.subscribe(map, "pointermove", (event: PointerEvent) => {
            const {x, y, width, height} = pointerOf(map, event)
            const key = ZoneMap.keyAt(x, width)
            const velocity = ZoneMap.velocityAt(y, height)
            readout.textContent = `${MidiKeys.toFullString(key)} / ${velocity}`
            if (isDefined(drag)) {
                if (key !== drag.key || velocity !== drag.velocity) {dragMoved = true}
                applyDrag(drag, key, velocity)
                refresh.notify()
            } else if (isDefined(band)) {
                rect = {
                    keyLo: Math.min(band.key, key), keyHi: Math.max(band.key, key),
                    velLo: Math.min(band.velocity, velocity), velHi: Math.max(band.velocity, velocity)
                }
                select(union(band.keep, ZoneMap.within(state(), rect)))
                refresh.notify()
            } else {
                map.style.cursor = ZoneMap.hit(state(), x, y, width, height, 5).mapOr(({edge}) => Cursors[edge], "")
            }
        }),
        Events.subscribe(map, "pointerup", () => {
            if (isDefined(drag) && !dragMoved && isDefined(drag.collapse)) {select(drag.collapse)}
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
        Events.subscribe(keys, "pointerup", () => {
            pressed = -1
            refresh.notify()
        })
    )
    selectDefault()
    updateGroups()
    updateZones()
    updateLabels()
    readout.textContent = "Key / Velocity"
    return (
        <div className={className}>
            <div className="example">
                <span>Example</span>
                <DropDown lifecycle={lifecycle} owner={instrumentIndex} width="10em"
                          provider={() => instruments.map((_, index) => index)}
                          mapping={index => instruments[index].name}/>
            </div>
            <h3>Device panel</h3>
            <div className="device">
                <header>
                    <Icon symbol={IconSymbol.NanoWave}/>
                    <h1>Sampler</h1>
                    <Button lifecycle={lifecycle} onClick={() => {}} appearance={{framed: true, color: Colors.shadow}}>
                        <span>Edit Sample Zones</span>
                    </Button>
                </header>
                <div className="controls">
                    <div className="stacks">{panelStacks.slice(0, 3)}</div>
                    <div className="stacks">{panelStacks.slice(3)}</div>
                    {panelModulation}
                </div>
            </div>
            <h3>Sample zone window</h3>
            <div className="window">
                <header>
                    {windowName}
                    {sampleCount}
                    {readout}
                    {tool("Clean Up", "Removes every sample no zone uses", cleanUp)}
                    <Button lifecycle={lifecycle} onClick={() => {}} appearance={{framed: true, color: Colors.shadow}}>
                        <span>Add Samples</span>
                    </Button>
                    <Button lifecycle={lifecycle} onClick={() => {}} appearance={{framed: true, color: Colors.shadow}}>
                        <span>Import SFZ / SF2</span>
                    </Button>
                </header>
                <div className="tools">
                    {tool("Select All", "Selects every zone of the shown group", () => select(visibleZones()))}
                    {tool("Map by Name", "Reads note and dynamic from the file names (C4, pp to fff) and maps the selected zones", mapByName)}
                    {tool("Spread Keys", "Extends each selected zone halfway to the neighbouring roots, so no key is left empty", spreadKeys)}
                    {tool("Spread Velocity", "Splits the velocity range evenly between the selected layers on the same keys", spreadVelocity)}
                    {tool("Crossfade", "Lets selected neighbours overlap and fade into each other, over keys and velocities", crossfade)}
                    {tool("Root to Low", "Sets the root key of each selected zone to its lowest key",
                        () => selection.forEach(zone => zone.rootKey = zone.keyLo))}
                    {tool("Duplicate", "Copies the selected zones onto the same keys, as further round robins", duplicate)}
                    <MenuButton appearance={{framed: true, color: Colors.shadow, tooltip: "Moves the selected zones into another group"}}
                                root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                    ...instrument().groups.map((entry, index) => MenuItem.default({label: entry.name})
                                        .setTriggerProcedure(() => moveToGroup(index)))))}>
                        <label><span>Move to Group</span><Icon symbol={IconSymbol.Dropdown}/></label>
                    </MenuButton>
                    {tool("Delete", "Removes the selected zones, their samples stay until Clean Up", remove)}
                    {selectionLabel}
                </div>
                <div className="display map">{map}</div>
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
                    {windowModulation}
                </div>
                <div className="inspector">
                    <div className="display waveform">
                        {waveform}
                        {sampleLabel}
                    </div>
                    <div className="stacks">
                        {stack(lifecycle, refresh, "orange", "Group", 1, [
                            groupField("Robin", "robin", 0, 2, 1, Print.choice(SamplerModel.RobinModes)),
                            groupField("Choke", "choke", 0, 16, 1, value => value === 0 ? ["Off", ""] : [String(value), ""]),
                            groupField("Trigger", "trigger", 0, 1, 1, Print.choice(SamplerModel.Triggers))
                        ])}
                        {stack(lifecycle, refresh, "yellow", "Key", 1, [
                            zoneField("Low", "keyLo", 0, 127, 1, Print.key),
                            zoneField("High", "keyHi", 0, 127, 1, Print.key),
                            zoneField("Fade", "keyFade", 0, 24, 1, Print.integer("st"))
                        ])}
                        {stack(lifecycle, refresh, "green", "Velocity", 1, [
                            zoneField("Low", "velLo", 1, 127, 1, Print.integer("")),
                            zoneField("High", "velHi", 1, 127, 1, Print.integer("")),
                            zoneField("Fade", "velFade", 0, 64, 1, Print.integer(""))
                        ])}
                        {stack(lifecycle, refresh, "blue", "Pitch", 1, [
                            zoneField("Root", "rootKey", 0, 127, 1, Print.key),
                            zoneField("Transp", "coarse", -24, 24, 1, Print.integer("st")),
                            zoneField("Tune", "tune", -100, 100, 1, Print.integer("ct"))
                        ])}
                        {stack(lifecycle, refresh, "purple", "Play", 2, [
                            zoneField("Gain", "gain", -72, 12, 0.5, Print.fixed(1, "dB")),
                            zoneField("Pan", "pan", -1, 1, 0.01, Print.pan),
                            zoneField("Track", "track", 0, 100, 1, Print.integer("%")),
                            zoneField("Seq", "sequence", 1, 8, 1, Print.integer("")),
                            zoneField("Reverse", "reverse", 0, 1, 1, Print.integer(""), true),
                            zoneField("One Shot", "oneShot", 0, 1, 1, Print.integer(""), true)
                        ])}
                        {stack(lifecycle, refresh, "cream", "Sample", 2, [
                            zoneField("Start", "start", 0, 1, 0.005, Print.percent),
                            zoneField("End", "end", 0, 1, 0.005, Print.percent),
                            zoneField("Loop", "loopMode", 0, 2, 1, Print.choice(SamplerModel.LoopModes)),
                            zoneField("Fade", "loopFade", 0, 0.25, 0.005, Print.seconds),
                            zoneField("From", "loopStart", 0, 1, 0.005, Print.percent),
                            zoneField("To", "loopEnd", 0, 1, 0.005, Print.percent)
                        ])}
                    </div>
                    <div className="stacks">{windowStacks}</div>
                </div>
            </div>
        </div>
    )
}
