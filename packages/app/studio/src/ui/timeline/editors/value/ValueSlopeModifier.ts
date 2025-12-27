import {clampUnit, Curve, Iterables, Notifier, Observer, Option, panic, Terminable, unitValue, ValueAxis} from "@opendaw/lib-std"
import {BoxEditing} from "@opendaw/lib-box"
import {ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {Interpolation, ppqn, ValueEvent} from "@opendaw/lib-dsp"
import {ValueModifier} from "./ValueModifier"
import {ValueEventDraft} from "@/ui/timeline/editors/value/ValueEventDraft.ts"
import {ValueEventOwnerReader} from "../EventOwnerReader"
import {Dragging} from "@opendaw/lib-dom"

type Construct = Readonly<{
    element: Element
    valueAxis: ValueAxis
    reference: ValueEventBoxAdapter
    collection: ValueEventCollectionBoxAdapter
}>

export class ValueSlopeModifier implements ValueModifier {
    static create(construct: Construct): ValueSlopeModifier {return new ValueSlopeModifier(construct)}

    readonly #element: Element
    readonly #valueAxis: ValueAxis
    readonly #reference: ValueEventBoxAdapter
    readonly #successor: ValueEventBoxAdapter
    readonly #collection: ValueEventCollectionBoxAdapter

    readonly #notifier: Notifier<void>

    #slope: unitValue

    private constructor({element, valueAxis, reference, collection}: Construct) {
        this.#element = element
        this.#valueAxis = valueAxis
        this.#reference = reference
        this.#successor = ValueEvent.nextEvent<ValueEventBoxAdapter>(collection.events, reference)
            ?? panic("No successor event")
        this.#collection = collection

        this.#notifier = new Notifier<void>()

        const interpolation = reference.interpolation
        this.#slope = interpolation.type === "curve" ? interpolation.slope : 0.5
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return false}
    snapValue(): Option<unitValue> {return Option.None}
    translateSearch(value: ppqn): ppqn {return value}
    isVisible(_event: ValueEvent): boolean {return true}
    readPosition(event: ValueEvent): ppqn {return event.position}
    readValue(event: ValueEvent): unitValue {return event.value}
    readInterpolation(event: ValueEventBoxAdapter): Interpolation {
        if (event !== this.#reference) {return event.interpolation}
        return Interpolation.Curve(this.#slope)
    }
    readContentDuration(owner: ValueEventOwnerReader): number {return owner.contentDuration}
    iterator(searchMin: ppqn, searchMax: ppqn): IterableIterator<ValueEventDraft> {
        return Iterables.map(ValueEvent.iterateWindow(this.#collection.events, searchMin, searchMax), event => ({
            type: "value-event",
            position: event.position,
            value: event.value,
            interpolation: this.readInterpolation(event),
            index: event.index,
            isSelected: event.isSelected,
            direction: 0
        }))
    }

    update({clientY}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const pointerValue = this.#valueAxis.axisToValue(clientY - clientRect.top)
        const v0 = this.#reference.value
        const v1 = this.#successor.value
        const slope = clampUnit(Curve.slopeByHalf(v0, pointerValue, v1))
        if (this.#slope !== slope) {
            this.#slope = slope
            this.#dispatchChange()
        }
    }

    approve(editing: BoxEditing): void {
        editing.modify(() => this.#reference.interpolation = Interpolation.Curve(this.#slope))
    }

    cancel(): void {
        const interpolation = this.#reference.interpolation
        this.#slope = interpolation.type === "curve" ? interpolation.slope : 0.5
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}