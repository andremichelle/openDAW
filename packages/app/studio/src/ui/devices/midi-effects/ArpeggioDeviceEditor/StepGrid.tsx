import css from "./StepGrid.sass?inline"
import {clamp, DefaultObservableValue, Editing, int, isDefined, Lifecycle, Terminator} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {ArpeggioDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {ArpeggioLanes} from "./ArpeggioLanes"

const className = Html.adoptStyleSheet(css, "ArpeggioStepGrid")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: ArpeggioDeviceBoxAdapter
    stepRange: DefaultObservableValue<int>
    lane: DefaultObservableValue<int>
    receiver: LiveStreamReceiver
}

export const StepGrid = ({lifecycle, editing, adapter, stepRange, lane, receiver}: Construct) => {
    const {box} = adapter
    const element: HTMLElement = <div className={className}/>
    const inner = lifecycle.own(new Terminator())
    const rebuild = () => {
        inner.terminate()
        const base = stepRange.getValue() - 16
        const columns = Array.from({length: 16}, (_, column) => base + column)
        const kindOf = (index: int): int => box.stepKinds.getField(index).getValue()
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
        const typeCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const cell: HTMLElement = <div className="type"><div className="glyph"/></div>
            const field = box.stepKinds.getField(index)
            const render = () => {
                const kind = field.getValue()
                ArpeggioLanes.Kinds.forEach((name, kindIndex) => cell.classList.toggle(name, kindIndex === kind))
                cell.title = `Step ${index + 1}: ${ArpeggioLanes.KindLabels[kind]}`
            }
            inner.ownAll(field.subscribe(render), Events.subscribe(cell, "click", () =>
                editing.modify(() => field.setValue((field.getValue() + 1) % ArpeggioLanes.Kinds.length))))
            render()
            return cell
        })
        const laneSpec = ArpeggioLanes.Values[lane.getValue()]
        const fieldsOf = laneSpec.fields(box)
        const laneCells: ReadonlyArray<HTMLElement> = columns.map(index => {
            const fill: HTMLElement = <div className="fill"/>
            const text: HTMLElement = <div className="text"/>
            const cell: HTMLElement = (
                <div className={Html.buildClassList("lane", laneSpec.bipolar && "bipolar")}>
                    {laneSpec.bipolar || isDefined(laneSpec.mark) ? <div className="mark"
                                                                       style={{bottom: `${laneSpec.ratio(laneSpec.mark ?? 0) * 100}%`}}/> : false}
                    {fill}
                    {text}
                </div>
            )
            const field = fieldsOf.getField(index)
            const render = () => {
                const value = field.getValue()
                const ratio = laneSpec.ratio(value)
                const zero = laneSpec.bipolar ? laneSpec.ratio(0) : 0
                fill.style.bottom = `${Math.min(ratio, zero) * 100}%`
                fill.style.height = `${Math.abs(ratio - zero) * 100}%`
                text.textContent = laneSpec.discrete ? laneSpec.format(value) : ""
                const kind = kindOf(index)
                const inactive = kind === ArpeggioLanes.Rest || kind === ArpeggioLanes.Tie
                cell.classList.toggle("inactive", inactive)
                cell.title = inactive ? `Step ${index + 1}: ${ArpeggioLanes.KindLabels[kind]}` : `${laneSpec.label} ${laneSpec.format(value)}`
            }
            inner.ownAll(field.subscribe(render), box.stepKinds.getField(index).subscribe(render))
            render()
            return cell
        })
        const laneLabels: HTMLElement = (
            <div className="lanes">
                {ArpeggioLanes.Values.map((spec, index) => (
                    <div className={Html.buildClassList("lane-label", index === lane.getValue() && "on")}
                         onclick={() => lane.setValue(index)}>{spec.label}</div>
                ))}
            </div>
        )
        const laneArea: HTMLElement = <div className="lane-area">{laneCells}</div>
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
                const kind = kindOf(index)
                if (kind === ArpeggioLanes.Rest || kind === ArpeggioLanes.Tie) {return}
                const rect = laneCells[column].getBoundingClientRect()
                const ratio = clamp(1.0 - (pointer.clientY - rect.top) / rect.height, 0.0, 1.0)
                const value = laneSpec.fromRatio(ratio)
                const field = fieldsOf.getField(index)
                if (field.getValue() === value) {return}
                editing.modify(() => field.setValue(value), mark)
                mark = false
            }
            paint(event)
            const move = Events.subscribe(window, "pointermove", (moveEvent: PointerEvent) => paint(moveEvent))
            const up = Events.subscribe(window, "pointerup", () => {
                move.terminate()
                up.terminate()
            })
        }))
        replaceChildren(element,
            <div className="corner"/>, ...indexCells,
            <div className="corner"/>, ...playCells,
            <div className="header">Type</div>, ...typeCells,
            laneLabels, laneArea)
    }
    lifecycle.ownAll(stepRange.subscribe(rebuild), lane.subscribe(rebuild))
    rebuild()
    return element
}
