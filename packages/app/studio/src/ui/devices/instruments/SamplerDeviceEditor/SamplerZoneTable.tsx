import {clamp, Editing, Func, int, isDefined, Lifecycle, Option, Optional, Procedure, Provider, Subscription} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {AudioData, MidiKeys} from "@opendaw/lib-dsp"
import {BooleanField, Int32Field} from "@opendaw/lib-box"
import {SamplerZoneBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {MenuItem} from "@opendaw/studio-core"
import {Icon} from "@/ui/components/Icon"
import {Menu} from "@/ui/components/Menu.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {SamplerValueLabel} from "./SamplerValueLabel"
import {SamplerZoneMap} from "./SamplerZoneMap"

export namespace SamplerZoneTable {
    type Zone = SamplerZoneBoxAdapter
    export type Table = { readonly element: HTMLElement, readonly zoneAt: Func<EventTarget, Option<Zone>> }
    export type Model = {
        readonly rows: Provider<ReadonlyArray<Zone>>
        readonly selection: Provider<ReadonlyArray<Zone>>
        readonly focused: Provider<Optional<Zone>>
        readonly select: (zones: ReadonlyArray<Zone>, focus: Zone) => void
        readonly toggle: Procedure<Zone>
        readonly remove: Procedure<Zone>
        readonly framesOf: Func<Zone, Optional<AudioData>>
        readonly nameOf: Func<Zone, string>
    }
    type Column = {
        readonly title: string
        readonly group: string
        readonly kind: "value" | "toggle" | "choice"
        readonly min: number
        readonly max: number
        readonly step: number
        readonly get: Func<Zone, number>
        readonly set: (zone: Zone, value: number) => void
        readonly print: (value: number, zone: Zone) => SamplerValueLabel.Printed
        readonly parse: (text: string, zone: Zone) => Option<number>
        // changes the row it is edited in only, whatever is selected
        readonly single?: boolean
        readonly disabled?: Func<Zone, boolean>
    }
    type Cell = { readonly zone: Zone, readonly column: Column }

    const MaxKey = SamplerZoneMap.NumKeys - 1
    const MaxFrame: int = 0x7FFFFFFF
    const MaxRows = 200
    const LoopNames: ReadonlyArray<string> = ["Off", "Gate", "Always"]
    const NoteOffsets: Readonly<Record<string, int>> = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11}
    const numberIn = (text: string): Option<number> => Option.wrap(SamplerValueLabel.numberIn(text))

    const parseKey = (text: string): Option<number> => {
        const note = /^\s*([a-g])(#?)(-?\d)\s*$/i.exec(text)
        return isDefined(note)
            ? Option.wrap(NoteOffsets[note[1].toLowerCase()] + (note[2] === "#" ? 1 : 0) + (parseInt(note[3]) + 2) * 12)
            : numberIn(text)
    }
    const printSeconds = (seconds: number): SamplerValueLabel.Printed =>
        seconds < 1.0 ? [String(Math.round(seconds * 1000)), "ms"] : [seconds.toFixed(2), "s"]
    const parseSeconds = (text: string): Option<number> =>
        numberIn(text).map(value => /ms/i.test(text) || (!/s/i.test(text) && value >= 10) ? value / 1000 : value)
    const scaled = (factor: number): Func<string, Option<number>> => text => numberIn(text).map(value => value / factor)

    const columns = (framesOf: Func<Zone, Optional<AudioData>>): ReadonlyArray<Column> => {
        const key = (title: string, field: Func<Zone, Int32Field>): Column => ({
            title, group: "Key", kind: "value", min: 0, max: MaxKey, step: 1,
            get: zone => field(zone).getValue(), set: (zone, value) => field(zone).setValue(Math.round(value)),
            print: value => [MidiKeys.toFullString(Math.round(value)), ""], parse: parseKey
        })
        const whole = (title: string, group: string, min: int, max: int, unit: string,
                       field: Func<Zone, Int32Field>): Column => ({
            title, group, kind: "value", min, max, step: 1,
            get: zone => field(zone).getValue(), set: (zone, value) => field(zone).setValue(Math.round(value)),
            print: value => [String(Math.round(value)), unit], parse: text => numberIn(text)
        })
        const toggle = (title: string, field: Func<Zone, BooleanField>): Column => ({
            title, group: "Playback", kind: "toggle", min: 0, max: 1, step: 1,
            get: zone => field(zone).getValue() ? 1 : 0, set: (zone, value) => field(zone).setValue(value >= 0.5),
            print: value => [value >= 0.5 ? "On" : "Off", ""], parse: text => Option.wrap(/on|1|yes/i.test(text) ? 1 : 0)
        })
        // positions are edited in seconds and stored in frames, the end of the sample when they reach it
        const position = (title: string, field: Func<Zone, Int32Field>, open: boolean, other: Func<Zone, Int32Field>): Column => {
            const lengthOf = (zone: Zone): number => {
                const frames = framesOf(zone)
                return isDefined(frames) && frames.sampleRate > 0 ? frames.numberOfFrames / frames.sampleRate : 0.0
            }
            return {
                title, group: "Waveform", kind: "value", min: 0.0, max: 3600.0, step: 0.005,
                disabled: zone => lengthOf(zone) === 0.0,
                get: zone => {
                    const frames = framesOf(zone)
                    return isDefined(frames) && frames.sampleRate > 0 ? Math.min(field(zone).getValue(), frames.numberOfFrames) / frames.sampleRate : 0.0
                },
                set: (zone, value) => {
                    const frames = framesOf(zone)
                    if (!isDefined(frames)) {return}
                    const limit = Math.min(other(zone).getValue(), frames.numberOfFrames)
                    const wanted = Math.round(clamp(value, 0.0, lengthOf(zone)) * frames.sampleRate)
                    const frame = open ? Math.max(wanted, limit + 1) : Math.max(0, Math.min(wanted, limit - 1))
                    field(zone).setValue(open && frame >= frames.numberOfFrames ? MaxFrame : frame)
                },
                print: printSeconds, parse: parseSeconds
            }
        }
        const low = (column: Column, limit: Func<Zone, number>): Column =>
            ({...column, set: (zone, value) => column.set(zone, Math.min(value, limit(zone)))})
        const high = (column: Column, limit: Func<Zone, number>): Column =>
            ({...column, set: (zone, value) => column.set(zone, Math.max(value, limit(zone)))})
        return [
            low(key("Low", zone => zone.box.keyLow), zone => zone.box.keyHigh.getValue()),
            high(key("High", zone => zone.box.keyHigh), zone => zone.box.keyLow.getValue()),
            whole("Fade", "Key", 0, 24, "", zone => zone.box.keyFade),
            low(whole("Low", "Velocity", 1, 127, "", zone => zone.box.velocityLow), zone => zone.box.velocityHigh.getValue()),
            high(whole("High", "Velocity", 1, 127, "", zone => zone.box.velocityHigh), zone => zone.box.velocityLow.getValue()),
            whole("Fade", "Velocity", 0, 64, "", zone => zone.box.velocityFade),
            {...key("Root", zone => zone.box.rootKey), group: "Pitch"},
            whole("Transp", "Pitch", -24, 24, "st", zone => zone.box.transpose),
            {
                title: "Tune", group: "Pitch", kind: "value", min: -100, max: 100, step: 1,
                get: zone => zone.box.tune.getValue(), set: (zone, value) => zone.box.tune.setValue(value),
                print: value => [String(Math.round(value)), "ct"], parse: text => numberIn(text)
            },
            {
                title: "Gain", group: "Playback", kind: "value", min: -72, max: 12, step: 0.1,
                get: zone => zone.box.gain.getValue(), set: (zone, value) => zone.box.gain.setValue(value),
                print: value => [value.toFixed(1), "dB"], parse: text => numberIn(text)
            },
            {
                title: "Pan", group: "Playback", kind: "value", min: -1, max: 1, step: 0.01,
                get: zone => zone.box.panning.getValue(), set: (zone, value) => zone.box.panning.setValue(value),
                print: value => Math.round(value * 100) === 0 ? ["C", ""] : [String(Math.abs(Math.round(value * 100))), value < 0 ? "L" : "R"],
                parse: text => /^\s*c\s*$/i.test(text) ? Option.wrap(0.0)
                    : numberIn(text).map(value => (/l/i.test(text) ? -Math.abs(value) : value) / 100)
            },
            {
                title: "Track", group: "Playback", kind: "value", min: 0, max: 1, step: 0.01,
                get: zone => zone.box.keyTrack.getValue(), set: (zone, value) => zone.box.keyTrack.setValue(value),
                print: value => [String(Math.round(value * 100)), "%"], parse: scaled(100)
            },
            {...whole("Turn", "Playback", 1, 128, "", zone => zone.box.sequence), single: true},
            toggle("Rev", zone => zone.box.reverse),
            toggle("1 Shot", zone => zone.box.oneShot),
            position("Start", zone => zone.box.sampleStart, false, zone => zone.box.sampleEnd),
            position("End", zone => zone.box.sampleEnd, true, zone => zone.box.sampleStart),
            {
                title: "Loop", group: "Waveform", kind: "choice", min: 0, max: 2, step: 1,
                disabled: zone => zone.box.oneShot.getValue(),
                get: zone => zone.box.loopMode.getValue(), set: (zone, value) => zone.box.loopMode.setValue(Math.round(value)),
                print: value => [LoopNames[Math.round(value)] ?? "", ""],
                parse: text => {
                    const index = LoopNames.findIndex(name => name.toLowerCase() === text.trim().toLowerCase())
                    return index >= 0 ? Option.wrap(index) : numberIn(text)
                }
            },
            {
                title: "Fade", group: "Waveform", kind: "value", min: 0, max: 1, step: 0.005,
                get: zone => zone.box.loopFade.getValue(), set: (zone, value) => zone.box.loopFade.setValue(value),
                print: printSeconds, parse: parseSeconds
            },
            position("From", zone => zone.box.loopStart, false, zone => zone.box.loopEnd),
            position("To", zone => zone.box.loopEnd, true, zone => zone.box.loopStart)
        ]
    }

    export const create = (lifecycle: Lifecycle, editing: Editing, observe: Func<Procedure<void>, Subscription>,
                           model: Model): Table => {
        const all = columns(model.framesOf)
        const groups = all.filter((column, index) => index === 0 || all[index - 1].group !== column.group).map(({group}) => group)
        const body: HTMLElement = <div className="body"/>
        const more: HTMLElement = <div className="more hidden"/>
        const hint: HTMLElement = <div className="hint">Click a zone on the map or a sample in the list. Its zones show here with all their values.</div>
        const cells = new WeakMap<Element, Cell>()
        const names = new WeakMap<Element, Zone>()
        const removes = new WeakMap<Element, Zone>()
        let rows: ReadonlyArray<{ readonly zone: Zone, readonly element: HTMLElement, readonly values: ReadonlyArray<HTMLElement> }> = []
        let signature = ""
        const targets = (zone: Zone): ReadonlyArray<Zone> => {
            const selection = model.selection()
            return selection.includes(zone) ? selection : [zone]
        }
        const apply = (zone: Zone, column: Column, value: number): void =>
            (column.single === true ? [zone] : targets(zone)).forEach(target => column.set(target, clamp(value, column.min, column.max)))
        const build = (zones: ReadonlyArray<Zone>): void => {
            rows = zones.map(zone => {
                const name: HTMLElement = <span className="name">{model.nameOf(zone)}</span>
                names.set(name, zone)
                const values: ReadonlyArray<HTMLElement> = all.map(column => {
                    const value: HTMLElement = (
                        <span className={`cell ${column.group.toLowerCase()} ${column.kind}`}>
                            {column.kind === "toggle" && <Icon symbol={IconSymbol.Checkbox}/>}
                        </span>
                    )
                    cells.set(value, {zone, column})
                    return value
                })
                const remove: HTMLElement = <div className="remove"><Icon symbol={IconSymbol.Close}/></div>
                removes.set(remove, zone)
                Array.from(remove.querySelectorAll("*")).forEach(child => removes.set(child, zone))
                return {zone, values, element: <div className="row">{name}{values}{remove}</div>}
            })
            body.replaceChildren(...rows.map(({element}) => element), more, hint)
        }
        const update = (): void => {
            const zones = model.rows()
            const shown = zones.slice(0, MaxRows)
            const next = shown.map(zone => `${zone.address.toString()}/${model.nameOf(zone)}`).join("|")
            if (next !== signature) {
                signature = next
                build(shown)
            }
            more.textContent = `and ${zones.length - shown.length} more`
            more.classList.toggle("hidden", zones.length <= shown.length)
            hint.classList.toggle("hidden", zones.length > 0)
            const selection = new Set(model.selection()), focused = model.focused()
            rows.forEach(({zone, element, values}) => {
                element.classList.toggle("selected", selection.has(zone))
                element.classList.toggle("active", zone === focused)
                element.classList.toggle("off", !zone.box.enabled.getValue())
                values.forEach((value, index) => {
                    const column = all[index]
                    value.classList.toggle("disabled", column.disabled?.(zone) === true)
                    if (column.kind === "toggle") {
                        value.classList.toggle("on", column.get(zone) >= 0.5)
                        return
                    }
                    const [text, unit] = column.print(column.get(zone), zone)
                    if (value.textContent !== text) {value.textContent = text}
                    if ((value.getAttribute("unit") ?? "") === unit) {return}
                    if (unit.length > 0) {value.setAttribute("unit", unit)} else {value.removeAttribute("unit")}
                })
            })
        }
        const fade = (): void => {
            body.classList.toggle("more-above", body.scrollTop > 0)
            body.classList.toggle("more-below", body.scrollTop + body.clientHeight < body.scrollHeight - 1)
        }
        const drag = SamplerValueLabel.gesture(editing)
        const cellOf = (event: Event): Option<Cell> => Option.wrap(event.target instanceof Element ? cells.get(event.target) : undefined)
        let pressed: Optional<Cell> = undefined
        let lastPressed: Optional<Cell> = undefined
        let repeated = false
        const end = (commit: boolean): void => {
            const cell = pressed
            pressed = undefined
            const clicked = drag.end(commit)
            if (clicked.isEmpty() || !isDefined(cell) || cell.column.kind === "value") {return}
            const {zone, column} = cell
            if (column.kind === "toggle") {
                editing.modify(() => apply(zone, column, 1 - column.get(zone)))
                return
            }
            const current = Math.round(column.get(zone))
            const root = MenuItem.root()
            for (let index = column.min; index <= column.max; index++) {
                root.addMenuItem(MenuItem.default({label: column.print(index, zone)[0], checked: index === current})
                    .setTriggerProcedure(() => editing.modify(() => apply(zone, column, index))))
            }
            const {element} = clicked.unwrap()
            const rect = element.getBoundingClientRect()
            const menu = Menu.create(root)
            menu.moveTo(rect.left, rect.bottom + Menu.Padding)
            menu.attach(Layers.get(element).flyout)
        }
        lifecycle.ownAll(
            observe(() => {
                update()
                fade()
            }),
            Events.subscribe(body, "scroll", fade),
            Events.subscribe(body, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0 || !(event.target instanceof Element)) {return}
                const previous = lastPressed
                lastPressed = undefined
                const removed = removes.get(event.target)
                if (isDefined(removed)) {
                    model.remove(removed)
                    return
                }
                const named = names.get(event.target)
                if (isDefined(named)) {
                    const anchor = model.focused()
                    const zones = rows.map(({zone}) => zone)
                    const from = isDefined(anchor) ? zones.indexOf(anchor) : -1
                    if (event.shiftKey && from >= 0 && isDefined(anchor)) {
                        const to = zones.indexOf(named)
                        model.select(zones.slice(Math.min(from, to), Math.max(from, to) + 1), anchor)
                    } else if (event.metaKey || event.ctrlKey) {
                        model.toggle(named)
                    } else {
                        model.select([named], named)
                    }
                    return
                }
                const cell = cellOf(event).unwrapOrUndefined()
                if (!isDefined(cell) || !(event.target instanceof HTMLElement)) {return}
                const {zone, column} = cell
                if (column.disabled?.(zone) === true) {return}
                body.setPointerCapture(event.pointerId)
                pressed = cell
                repeated = previous?.zone === zone && previous.column === column
                lastPressed = cell
                drag.begin({
                    element: event.target, min: column.min, max: column.max,
                    step: column.kind === "value" ? column.step : 0,
                    get: () => column.get(zone), set: value => apply(zone, column, value)
                }, event)
            }),
            Events.subscribe(body, "pointermove", (event: PointerEvent) => {
                if (pressed?.column.kind === "value") {drag.move(event)}
            }),
            Events.subscribe(body, "pointerup", () => end(true)),
            Events.subscribe(body, "pointercancel", () => end(false)),
            Events.subscribe(body, "dblclick", async (event: MouseEvent) => {
                // the pointer is captured by the body, so the cell is the one that was pressed last
                const cell = lastPressed
                if (!repeated || !isDefined(cell) || cell.column.kind !== "value") {return}
                end(false)
                const {zone, column} = cell
                const [text, unit] = column.print(column.get(zone), zone)
                const typed = await SamplerValueLabel.ask(body, event, unit.length > 0 ? `${text} ${unit}` : text)
                if (!zone.box.isAttached()) {return}
                typed.flatMap(text => column.parse(text, zone)).ifSome(value => {
                    if (Number.isFinite(value)) {editing.modify(() => apply(zone, column, value))}
                })
            })
        )
        build([])
        update()
        const zoneAt = (target: EventTarget): Option<Zone> =>
            Option.wrap(rows.find(({element}) => target instanceof Node && element.contains(target))?.zone)
        const element: HTMLElement = (
            <div className="zone-table">
                <div className="head groups">
                    <span className="name"/>
                    {groups.map(group => (
                        <span className={`group ${group.toLowerCase()}`}
                              style={{gridColumn: `span ${all.filter(column => column.group === group).length}`}}>{group}</span>
                    ))}
                    <span/>
                </div>
                <div className="head titles">
                    <span className="name">Sample</span>
                    {all.map(column => <span className={`cell ${column.group.toLowerCase()}`}>{column.title}</span>)}
                    <span/>
                </div>
                <div className="frame">{body}</div>
            </div>
        )
        return {element, zoneAt}
    }
}
