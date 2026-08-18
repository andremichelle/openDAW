import css from "./PatternGrid.sass?inline"
import {
    clamp,
    Color,
    DefaultObservableValue,
    Editing,
    EmptyExec,
    int,
    Lifecycle,
    Point,
    Terminator
} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {MidiKeys} from "@opendaw/lib-dsp"
import {CubedDeviceBoxAdapter, CubedPatternData, CubedStep} from "@opendaw/studio-adapters"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput.tsx"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Colors} from "@opendaw/studio-enums"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"

const className = Html.adoptStyleSheet(css, "CubedPatternGrid")

type Construct = {
    lifecycle: Lifecycle
    editing: Editing
    adapter: CubedDeviceBoxAdapter
    stepRange: DefaultObservableValue<int>
    receiver: LiveStreamReceiver
}

export const PatternGrid = ({lifecycle, editing, adapter, stepRange, receiver}: Construct) => {
    const {patternIndex} = adapter.namedParameter
    const writeStep = (absIndex: int, mutate: (step: CubedStep) => void) => editing.modify(() => {
        const field = adapter.currentPattern().steps.getField(absIndex)
        const step = CubedStep.unpack(field.getValue())
        mutate(step)
        field.setValue(CubedStep.pack(step))
    })
    const element: HTMLElement = <div className={className}/>
    const inner = lifecycle.own(new Terminator())
    const rebuild = () => {
        inner.terminate()
        const pattern = adapter.currentPattern()
        const base = (Math.floor(stepRange.getValue() / 16) - 1) * 16
        const readStep = (absIndex: int): CubedStep => CubedStep.unpack(pattern.steps.getField(absIndex).getValue())
        const onChange = (absIndex: int, observer: () => void) =>
            inner.own(pattern.steps.getField(absIndex).subscribe(observer))
        const noteCell = (absIndex: int): HTMLElement => {
            const cell: HTMLElement = <div className="cell note"/>
            const render = () => cell.textContent = MidiKeys.toFullString(readStep(absIndex).note)
            onChange(absIndex, render)
            render()
            inner.ownAll(
                Events.subscribe(cell, "pointerdown", (event: PointerEvent) => {
                    if (event.button !== 0) {return}
                    const startY = event.clientY
                    const startNote = readStep(absIndex).note
                    let lastNote = startNote
                    const move = Events.subscribe(window, "pointermove", (moveEvent: PointerEvent) => {
                        const note = clamp(startNote + Math.round((startY - moveEvent.clientY) / 4), 0, 127)
                        if (note !== lastNote) {
                            lastNote = note
                            writeStep(absIndex, step => step.note = note)
                        }
                    })
                    const up = Events.subscribe(window, "pointerup", () => {
                        move.terminate()
                        up.terminate()
                    })
                }),
                Events.subscribe(cell, "dblclick", () => {
                    const resolvers = Promise.withResolvers<string>()
                    const surface = Surface.get(cell)
                    surface.flyout.appendChild(FloatingTextInput({
                        resolvers,
                        position: Point.add(surface.pointer, {x: 0, y: 16}),
                        value: MidiKeys.toFullString(readStep(absIndex).note)
                    }))
                    resolvers.promise.then(
                        text => CubedPatternData.parseNote(text)
                            .ifSome(note => writeStep(absIndex, step => step.note = note)),
                        EmptyExec)
                })
            )
            return cell
        }
        const toggleCell = (absIndex: int, key: "active" | "slide" | "accent", color: Color): HTMLElement => {
            const cell: HTMLElement = (
                <div className="cell toggle" style={{color: color.toString()}}>
                    <div className="square"/>
                </div>
            )
            const render = () => cell.classList.toggle("on", readStep(absIndex)[key])
            onChange(absIndex, render)
            render()
            inner.own(Events.subscribe(cell, "click", () => writeStep(absIndex, step => step[key] = !step[key])))
            return cell
        }
        const indexCell = (column: int): HTMLElement => {
            const stepNumber = base + column + 1
            const cell: HTMLElement = <div className="index">{String(stepNumber)}</div>
            const render = () => cell.classList.toggle("beyond", stepNumber > pattern.length.getValue())
            inner.own(pattern.length.subscribe(render))
            render()
            return cell
        }
        const row = (label: string, cell: (absIndex: int) => HTMLElement): ReadonlyArray<HTMLElement> => [
            <div className="header">{label}</div>,
            ...Array.from({length: 16}, (_, column) => cell(base + column))
        ]
        const playCells: ReadonlyArray<HTMLElement> = Array.from({length: 16}, () => <div className="play"/>)
        inner.own(receiver.subscribeIntegers(adapter.address.append(0), array => {
            const step = array[0]
            playCells.forEach((cell, column) => cell.classList.toggle("on", base + column === step))
        }))
        replaceChildren(element,
            <div className="corner"/>,
            ...Array.from({length: 16}, (_, column) => indexCell(column)),
            <div className="corner"/>,
            ...playCells,
            ...row("Note", noteCell),
            ...row("Mode", index => toggleCell(index, "active", Colors.blue)),
            ...row("Slide", index => toggleCell(index, "slide", Colors.orange)),
            ...row("Accent", index => toggleCell(index, "accent", Colors.purple)))
    }
    lifecycle.ownAll(
        patternIndex.catchupAndSubscribe(rebuild),
        stepRange.subscribe(rebuild))
    return element
}
