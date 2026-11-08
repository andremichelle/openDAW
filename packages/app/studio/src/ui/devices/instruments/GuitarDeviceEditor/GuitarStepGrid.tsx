import css from "./GuitarStepGrid.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {GuitarDeviceBoxAdapter, GuitarPatterns} from "@opendaw/studio-adapters"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"

const className = Html.adoptStyleSheet(css, "GuitarStepGrid")

export const Lanes: ReadonlyArray<string> = ["Velocity", "Strings", "Speed"]

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: GuitarDeviceBoxAdapter
    page: DefaultObservableValue<int>
    lane: DefaultObservableValue<int>
    brush: DefaultObservableValue<int>
    receiver: LiveStreamReceiver
}

export const GuitarStepGrid = ({lifecycle, editing, adapter, page, lane, brush, receiver}: Construct) => {
    const {box} = adapter
    const element: HTMLElement = <div className={className}/>
    const inner = lifecycle.own(new Terminator())
    const silent = (kind: int) => kind === GuitarPatterns.Rest || kind === GuitarPatterns.Stop
    const ignoresStrings = (kind: int) => silent(kind) || kind === GuitarPatterns.Chuck
        || kind === GuitarPatterns.Bass || kind === GuitarPatterns.Alternate
    const custom = () => box.pattern.setValue(-1)
    const rebuild = () => {
        inner.terminate()
        const columns = Array.from({length: 16}, (_, column) => page.getValue() * 16 + column)
        const indexCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const cell: HTMLElement = <div className="index">{String(index + 1)}</div>
            const render = () => cell.classList.toggle("beyond", index >= box.patternLength.getValue())
            inner.own(box.patternLength.subscribe(render))
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
            const kindField = box.stepKinds.getField(index)
            const stringsField = box.stepStrings.getField(index)
            const render = () => {
                const kind = kindField.getValue()
                const entry = GuitarPatterns.Kinds.find(candidate => candidate.kind === kind)
                const strings = stringsField.getValue()
                const single = kind === GuitarPatterns.Pick && (strings & (strings - 1)) === 0 && strings !== 0
                cell.textContent = kind === GuitarPatterns.Rest ? "" : single ? String(6 - Math.log2(strings)) : entry?.glyph ?? ""
                cell.classList.toggle("quiet", kind === GuitarPatterns.Mute || kind === GuitarPatterns.Chuck || kind === GuitarPatterns.Stop)
                cell.classList.toggle("beyond", index >= box.patternLength.getValue())
                cell.title = `Step ${index + 1}: ${entry?.label ?? "Rest"}`
            }
            inner.ownAll(kindField.subscribe(render), stringsField.subscribe(render), box.patternLength.subscribe(render),
                Events.subscribe(cell, "click", () => editing.modify(() => {
                    const kind = brush.getValue()
                    kindField.setValue(kindField.getValue() === kind ? GuitarPatterns.Rest : kind)
                    custom()
                })))
            render()
            return cell
        })
        const laneIndex = lane.getValue()
        const stringsLane = laneIndex === 1
        const valuesOf = laneIndex === 0 ? box.stepVelocities : box.stepSpeeds
        const laneCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const kindField = box.stepKinds.getField(index)
            if (stringsLane) {
                const field = box.stepStrings.getField(index)
                const dots: ReadonlyArray<HTMLElement> = Array.from({length: 6}, (_, row) => {
                    const string = 5 - row
                    const dot: HTMLElement = <div/>
                    inner.own(Events.subscribe(dot, "click", () => editing.modify(() => {
                        field.setValue(field.getValue() ^ (1 << string))
                        custom()
                    })))
                    return dot
                })
                const cell: HTMLElement = <div className="lane strings">{dots}</div>
                const render = () => {
                    const mask = field.getValue()
                    dots.forEach((dot, row) => dot.classList.toggle("on", (mask & (1 << (5 - row))) !== 0))
                    cell.classList.toggle("inactive", ignoresStrings(kindField.getValue()))
                    cell.classList.toggle("beyond", index >= box.patternLength.getValue())
                }
                inner.ownAll(field.subscribe(render), kindField.subscribe(render), box.patternLength.subscribe(render))
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
                cell.classList.toggle("beyond", index >= box.patternLength.getValue())
                cell.title = `${Lanes[laneIndex]} ${value}%`
            }
            inner.ownAll(field.subscribe(render), kindField.subscribe(render), box.patternLength.subscribe(render))
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
                if (event.button !== 0) {return}
                let mark = true
                const paint = (pointer: PointerEvent) => {
                    const column = laneCells.findIndex(cell => {
                        const rect = cell.getBoundingClientRect()
                        return pointer.clientX >= rect.left - 1 && pointer.clientX <= rect.right + 1
                    })
                    if (column < 0) {return}
                    const index = columns[column]
                    if (silent(box.stepKinds.getField(index).getValue())) {return}
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
    lifecycle.ownAll(page.subscribe(rebuild), lane.subscribe(rebuild))
    rebuild()
    return element
}
