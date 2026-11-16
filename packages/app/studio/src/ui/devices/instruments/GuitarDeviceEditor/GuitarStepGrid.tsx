import css from "./GuitarStepGrid.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, ObservableValue, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {GuitarDeviceBoxAdapter, GuitarPatterns} from "@opendaw/studio-adapters"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {ContextMenu, MenuItem} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "GuitarStepGrid")

export const Lanes: ReadonlyArray<string> = ["Velocity", "Strings", "Speed"]

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: GuitarDeviceBoxAdapter
    page: DefaultObservableValue<int>
    lane: DefaultObservableValue<int>
    brush: DefaultObservableValue<int>
    slot: ObservableValue<int>
    receiver: LiveStreamReceiver
}

export const GuitarStepGrid = ({lifecycle, editing, adapter, page, lane, brush, slot, receiver}: Construct) => {
    const {box} = adapter
    const element: HTMLElement = <div className={className}/>
    const inner = lifecycle.own(new Terminator())
    const silent = (kind: int) => kind === GuitarPatterns.Rest || kind === GuitarPatterns.Stop
    const ignoresStrings = (kind: int) => silent(kind) || kind === GuitarPatterns.Chuck
        || kind === GuitarPatterns.Bass || kind === GuitarPatterns.Alternate
    const rebuild = () => {
        inner.terminate()
        const pattern = GuitarPatterns.slot(box, slot.getValue())
        const custom = () => pattern.library.setValue(-1)
        const columns = Array.from({length: 16}, (_, column) => page.getValue() * 16 + column)
        const indexCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const cell: HTMLElement = <div className="index">{String(index + 1)}</div>
            const render = () => cell.classList.toggle("beyond", index >= pattern.length.getValue())
            inner.own(pattern.length.subscribe(render))
            render()
            return cell
        })
        const playCells: ReadonlyArray<HTMLElement> = columns.map(() => <div className="play"/>)
        inner.own(receiver.subscribeIntegers(adapter.address.append(0), array => {
            const playing = array[0]
            playCells.forEach((cell, column) => cell.classList.toggle("on", columns[column] === playing))
        }))
        const strokeCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const cell: HTMLElement = <div className="stroke"/>
            const kindField = pattern.stepKinds.getField(index)
            const stringsField = pattern.stepStrings.getField(index)
            const render = () => {
                const kind = kindField.getValue()
                const entry = GuitarPatterns.Kinds.find(candidate => candidate.kind === kind)
                const strings = stringsField.getValue()
                const single = kind === GuitarPatterns.Pick && (strings & (strings - 1)) === 0 && strings !== 0
                cell.textContent = kind === GuitarPatterns.Rest ? "" : single ? String(6 - Math.log2(strings)) : entry?.glyph ?? ""
                cell.classList.toggle("quiet", kind === GuitarPatterns.Mute || kind === GuitarPatterns.Chuck || kind === GuitarPatterns.Stop)
                cell.classList.toggle("beyond", index >= pattern.length.getValue())
                cell.title = `Step ${index + 1}: ${entry?.label ?? "Rest"}`
            }
            inner.ownAll(kindField.subscribe(render), stringsField.subscribe(render), pattern.length.subscribe(render),
                Events.subscribe(cell, "click", (event: MouseEvent) => {
                    if (event.ctrlKey) {return}
                    editing.modify(() => {
                        const kind = brush.getValue()
                        GuitarPatterns.setStroke(pattern, index, kindField.getValue() === kind ? GuitarPatterns.Rest : kind)
                    })
                }))
            render()
            return cell
        })
        const laneIndex = lane.getValue()
        const stringsLane = laneIndex === 1
        const valuesOf = laneIndex === 0 ? pattern.stepVelocities : pattern.stepSpeeds
        const laneCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const kindField = pattern.stepKinds.getField(index)
            if (stringsLane) {
                const field = pattern.stepStrings.getField(index)
                const bendsField = pattern.stepBends.getField(index)
                const states = GuitarPatterns.Bends.length + 1
                const stateOf = (string: int) => (field.getValue() & (1 << string)) === 0
                    ? 0 : 1 + GuitarPatterns.bendOf(bendsField.getValue(), string)
                const setState = (string: int, state: int) => editing.modify(() => {
                    const on = state > 0
                    field.setValue(on ? field.getValue() | (1 << string) : field.getValue() & ~(1 << string))
                    bendsField.setValue(GuitarPatterns.withBend(bendsField.getValue(), string, on ? state - 1 : 0))
                    custom()
                })
                const setStrings = (mask: int) => editing.modify(() => {
                    field.setValue(mask)
                    bendsField.setValue(0)
                    custom()
                })
                const dots: ReadonlyArray<HTMLElement> = Array.from({length: 6}, (_, row) => {
                    const string = 5 - row
                    const dot: HTMLElement = <div/>
                    inner.ownAll(
                        Events.subscribe(dot, "click", (event: MouseEvent) => {
                            if (event.ctrlKey) {return}
                            setState(string, (stateOf(string) + 1) % states)
                        }),
                        ContextMenu.subscribe(dot, collector => collector.addItems(
                            ...GuitarPatterns.Bends.map((label, amount) => MenuItem.default({
                                label: amount === 0 ? "No Bend" : `Bend ${label}`, checked: stateOf(string) === amount + 1
                            }).setTriggerProcedure(() => setState(string, amount + 1))),
                            MenuItem.default({label: "All Strings", separatorBefore: true})
                                .setTriggerProcedure(() => setStrings(GuitarPatterns.AllStrings)),
                            MenuItem.default({label: "No Strings"}).setTriggerProcedure(() => setStrings(0)))))
                    return dot
                })
                const cell: HTMLElement = <div className="lane strings">{dots}</div>
                const render = () => {
                    dots.forEach((dot, row) => {
                        const string = 5 - row
                        const state = stateOf(string)
                        dot.classList.toggle("on", state > 0)
                        dot.classList.toggle("bent", state > 1)
                        dot.style.setProperty("--bend", String(Math.max(0, state - 1) / (GuitarPatterns.Bends.length - 1)))
                        dot.title = state === 0 ? `String ${6 - string}`
                            : state === 1 ? `String ${6 - string} plucked` : `String ${6 - string} bent ${GuitarPatterns.Bends[state - 1]}`
                    })
                    cell.classList.toggle("inactive", ignoresStrings(kindField.getValue()))
                    cell.classList.toggle("beyond", index >= pattern.length.getValue())
                }
                inner.ownAll(field.subscribe(render), bendsField.subscribe(render), kindField.subscribe(render),
                    pattern.length.subscribe(render))
                render()
                return cell
            }
            const fill: HTMLElement = <div className="fill"/>
            const cell: HTMLElement = <div className="lane">{fill}</div>
            const field = valuesOf.getField(index)
            const render = () => {
                const value = field.getValue()
                fill.style.setProperty("--value", String(value / 100))
                cell.classList.toggle("inactive", silent(kindField.getValue()))
                cell.classList.toggle("beyond", index >= pattern.length.getValue())
                cell.title = `${Lanes[laneIndex]} ${value}%`
            }
            inner.ownAll(field.subscribe(render), kindField.subscribe(render), pattern.length.subscribe(render))
            render()
            return cell
        })
        const laneLabels: HTMLElement = (
            <div className="lanes">
                {Lanes.map((label, index) => (
                    <div className={Html.buildClassList("lane-label", index === laneIndex && "on")}
                         onclick={() => lane.setValue(index)}>{label}</div>
                ))}
            </div>
        )
        const laneArea: HTMLElement = <div className="lane-area">{laneCells}</div>
        if (!stringsLane) {
            const drag = inner.own(new Terminator())
            inner.own(Events.subscribe(laneArea, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0 || event.ctrlKey) {return}
                let mark = true
                const paint = (pointer: PointerEvent) => {
                    const column = laneCells.findIndex(cell => {
                        const rect = cell.getBoundingClientRect()
                        return pointer.clientX >= rect.left - 1 && pointer.clientX <= rect.right + 1
                    })
                    if (column < 0) {return}
                    const index = columns[column]
                    if (silent(pattern.stepKinds.getField(index).getValue())) {return}
                    const rect = laneCells[column].getBoundingClientRect()
                    const value = Math.round(clamp(1.0 - (pointer.clientY - rect.top - 3) / (rect.height - 6), 0.0, 1.0) * 100)
                    const field = valuesOf.getField(index)
                    if (field.getValue() === value) {return}
                    editing.modify(() => {
                        field.setValue(value)
                        custom()
                    }, mark)
                    mark = false
                }
                paint(event)
                drag.terminate()
                drag.ownAll(
                    Events.subscribe(window, "pointermove", (moveEvent: PointerEvent) => paint(moveEvent)),
                    Events.subscribe(window, "pointerup", () => drag.terminate()))
            }))
        }
        replaceChildren(element,
            <div className="corner"/>, ...indexCells,
            <div className="corner"/>, ...playCells,
            <div className="header">Stroke</div>, ...strokeCells,
            laneLabels, laneArea)
    }
    lifecycle.ownAll(page.subscribe(rebuild), lane.subscribe(rebuild), slot.subscribe(rebuild))
    rebuild()
    return element
}
