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
    const strums = (kind: int) => kind === GuitarPatterns.Down || kind === GuitarPatterns.Up
        || kind === GuitarPatterns.Mute || kind === GuitarPatterns.Chop
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
                        const previous = kindField.getValue()
                        if (previous === kind) {
                            kindField.setValue(GuitarPatterns.Rest)
                        } else {
                            if (strums(kind) && !strums(previous)) {stringsField.setValue(GuitarPatterns.AllStrings)}
                            if (kind === GuitarPatterns.Pick) {stringsField.setValue(0)}
                            kindField.setValue(kind)
                        }
                        custom()
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
                const dots: ReadonlyArray<HTMLElement> = Array.from({length: 6}, (_, row) => {
                    const string = 5 - row
                    const dot: HTMLElement = <div/>
                    const setMask = (mask: int) => editing.modify(() => {
                        field.setValue(mask)
                        custom()
                    })
                    inner.ownAll(
                        Events.subscribe(dot, "click", (event: MouseEvent) => {
                            if (event.ctrlKey) {return}
                            setMask(event.shiftKey ? 1 << string : field.getValue() ^ (1 << string))
                        }),
                        ContextMenu.subscribe(dot, collector => collector.addItems(
                            MenuItem.default({label: `Only String ${6 - string}`}).setTriggerProcedure(() => setMask(1 << string)),
                            MenuItem.default({label: "All Strings"}).setTriggerProcedure(() => setMask(GuitarPatterns.AllStrings)),
                            MenuItem.default({label: "No Strings"}).setTriggerProcedure(() => setMask(0)))))
                    dot.title = `String ${6 - string} (Shift-click plays only this string)`
                    return dot
                })
                const cell: HTMLElement = <div className="lane strings">{dots}</div>
                const render = () => {
                    const mask = field.getValue()
                    dots.forEach((dot, row) => dot.classList.toggle("on", (mask & (1 << (5 - row))) !== 0))
                    cell.classList.toggle("inactive", ignoresStrings(kindField.getValue()))
                    cell.classList.toggle("beyond", index >= pattern.length.getValue())
                }
                inner.ownAll(field.subscribe(render), kindField.subscribe(render), pattern.length.subscribe(render))
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
                const move = Events.subscribe(window, "pointermove", (moveEvent: PointerEvent) => paint(moveEvent))
                const up = Events.subscribe(window, "pointerup", () => {
                    move.terminate()
                    up.terminate()
                })
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
