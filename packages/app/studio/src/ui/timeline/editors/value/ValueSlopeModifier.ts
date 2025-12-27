import {
    clampUnit,
    Curve,
    Iterables,
    Notifier,
    Observer,
    Option,
    panic,
    Terminable,
    unitValue,
    ValueAxis
} from "@opendaw/lib-std"
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

    readonly #initialSlope: unitValue
    #slope: unitValue
    #lastY: number = NaN

    private constructor({element, valueAxis, reference, collection}: Construct) {
        this.#element = element
        this.#valueAxis = valueAxis
        this.#reference = reference
        this.#successor = ValueEvent.nextEvent<ValueEventBoxAdapter>(collection.events, reference)
            ?? panic("No successor event")
        this.#collection = collection

        this.#notifier = new Notifier<void>()

        const interpolation = reference.interpolation
        this.#initialSlope = interpolation.type === "curve" ? interpolation.slope : 0.5
        this.#slope = this.#initialSlope
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
        return this.#slope === 0.5 ? Interpolation.Linear : Interpolation.Curve(this.#slope)
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

    update({clientY, altKey}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const localY = clientY - clientRect.top
        const y0 = this.#valueAxis.valueToAxis(this.#reference.value)
        const y1 = this.#valueAxis.valueToAxis(this.#successor.value)
        let targetY: number
        if (altKey) {
            if (Number.isNaN(this.#lastY)) {this.#lastY = localY}
            const deltaY = (localY - this.#lastY) * 0.1
            this.#lastY = localY
            const currentMidY = Curve.normalizedAt(0.5, this.#slope) * (y1 - y0) + y0
            targetY = currentMidY + deltaY
        } else {
            this.#lastY = localY
            targetY = localY
        }
        let slope = clampUnit(Curve.slopeByHalf(y0, targetY, y1))
        if (!altKey && Math.abs(slope - 0.5) < 0.02) {slope = 0.5}
        if (this.#slope !== slope) {
            this.#slope = slope
            this.#dispatchChange()
        }
    }

    approve(editing: BoxEditing): void {
        const interpolation = this.#slope === 0.5 ? Interpolation.Linear : Interpolation.Curve(this.#slope)
        editing.modify(() => this.#reference.interpolation = interpolation)
    }

    cancel(): void {
        const interpolation = this.#reference.interpolation
        this.#slope = interpolation.type === "curve" ? interpolation.slope : 0.5
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}