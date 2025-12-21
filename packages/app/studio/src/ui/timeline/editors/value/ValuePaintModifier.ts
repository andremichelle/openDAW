import {
    Arrays,
    BinarySearch,
    int,
    Iterables,
    Notifier,
    NumberComparator,
    Observer,
    Option,
    panic,
    Selection,
    Terminable,
    unitValue,
    ValueAxis
} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {ValueEventBoxAdapter} from "@opendaw/studio-adapters"
import {Interpolation, ppqn, ValueEvent} from "@opendaw/lib-dsp"
import {ValueModifier} from "./ValueModifier"
import {ValueEventDraft} from "@/ui/timeline/editors/value/ValueEventDraft.ts"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {UIValueEvent} from "@/ui/timeline/editors/value/UIValueEvent.ts"
import {Dragging} from "@opendaw/lib-dom"

type Construct = Readonly<{
    element: Element
    reader: ValueEventOwnerReader
    selection: Selection<ValueEventBoxAdapter>
    snapping: Snapping
    valueAxis: ValueAxis
}>

type Stroke = { position: ppqn, value: unitValue }

export class ValuePaintModifier implements ValueModifier {
    static create(construct: Construct): ValuePaintModifier {return new ValuePaintModifier(construct)}

    readonly #element: Element
    readonly #reader: ValueEventOwnerReader
    readonly #selection: Selection<ValueEventBoxAdapter>
    readonly #snapping: Snapping
    readonly #valueAxis: ValueAxis

    readonly #notifier: Notifier<void>
    readonly #strokes: Array<Stroke>

    #lastPosition: ppqn = NaN
    #lastValue: unitValue = NaN
    #lastIndex: int = 0

    private constructor({element, reader, selection, snapping, valueAxis}: Construct) {
        this.#element = element
        this.#reader = reader
        this.#selection = selection
        this.#selection.deselectAll()
        this.#snapping = snapping
        this.#valueAxis = valueAxis

        this.#notifier = new Notifier<void>()
        this.#strokes = []
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return false}
    snapValue(): Option<unitValue> {return Option.None}
    translateSearch(value: ppqn): ppqn {return value}
    isVisible(_event: ValueEvent): boolean {return true}
    readPosition(event: ValueEvent): ppqn {return event.position}
    readValue(event: ValueEvent): unitValue {return event.value}
    readInterpolation(event: UIValueEvent): Interpolation {return event.interpolation}
    * iterator(searchMin: ppqn, searchMax: ppqn): Generator<ValueEventDraft> {
        const offset = this.#reader.offset
        const min = Arrays.getFirst(this.#strokes, "Internal Error").position - offset
        const max = Arrays.getLast(this.#strokes, "Internal Error").position - offset

        const iteratorObject = Iterables.map(ValueEvent.iterateWindow(this.#reader.content.events, searchMin, min),
            (event: UIValueEvent): ValueEventDraft => ({
                type: "value-event",
                position: event.position,
                value: event.value,
                interpolation: event.interpolation,
                index: event.index,
                isSelected: event.isSelected,
                direction: 0
            })).filter(event => event.position < min)
        for (const event of iteratorObject) {yield event}
        for (const event of this.#strokes.map<ValueEventDraft>(stroke => ({
            type: "value-event",
            position: stroke.position - this.#reader.offset,
            value: stroke.value,
            interpolation: Interpolation.Linear,
            index: 0,
            isSelected: true,
            direction: 0
        }))) {yield event}
        for (const event of Array.from(ValueEvent.iterateWindow(this.#reader.content.events, max, searchMax))
            .map<ValueEventDraft>(event => ({
                type: "value-event",
                position: event.position,
                value: event.value,
                interpolation: event.interpolation,
                index: event.index,
                isSelected: event.isSelected,
                direction: 0
            })).filter(event => event.position > max)) {yield event}
    }
    readContentDuration(owner: ValueEventOwnerReader): number {return owner.contentDuration}

    update({clientX, clientY}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const position: ppqn = this.#snapping.xToUnitFloor(clientX - clientRect.left)
        const value: unitValue = this.#valueAxis.axisToValue(clientY - clientRect.top)
        if (this.#lastPosition === position && this.#lastValue === value) {return}
        if (this.#strokes.length === 0) {
            this.#strokes.push({position, value})
            this.#lastIndex = 0
        } else {
            const index = BinarySearch.leftMostMapped(this.#strokes, position, NumberComparator, ({position}) => position)
            if (index === this.#strokes.length) {
                this.#strokes.push({position, value})
            } else {
                const minIndex = Math.min(index, this.#lastIndex)
                const maxIndex = Math.max(index, this.#lastIndex)
                for (let i = minIndex; i <= maxIndex; i++) {this.#strokes[i].value = value}
                if (this.#strokes[index].position !== position) {
                    this.#strokes.splice(index, 0, {position, value})
                }
            }
            this.#lastIndex = index
        }
        this.#lastPosition = position
        this.#lastValue = value
        this.#dispatchChange()
    }

    approve(editing: BoxEditing): void {
        this.#verifyStrokes()
        const offset = this.#reader.offset
        const min = Arrays.getFirst(this.#strokes, "Internal Error").position - offset
        const max = Arrays.getLast(this.#strokes, "Internal Error").position - offset
        const content = this.#reader.content
        const deletion = Array.from(content.events.iterateRange(min, max + 1))
        editing.modify(() => {
            deletion.forEach(event => event.box.delete())
            this.#selection.select(...this.#strokes.map(stroke => content.createEvent({
                position: stroke.position - offset,
                value: stroke.value,
                interpolation: Interpolation.Linear,
                index: 0
            })))
        })
    }

    cancel(): void {this.#dispatchChange()}

    #dispatchChange(): void {this.#notifier.notify()}

    #verifyStrokes(): void {
        if (this.#strokes.length === 0) {return panic("No strokes available")}
        let prev = this.#strokes[0]
        for (let i = 1; i < this.#strokes.length; i++) {
            const next = this.#strokes[i]
            if (prev.position >= next.position) {return panic("Unsorted")}
            prev = next
        }
    }
}