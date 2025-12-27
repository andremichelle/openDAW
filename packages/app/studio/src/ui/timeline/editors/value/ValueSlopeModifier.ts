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
    readonly #reference: ValueEventBoxAdapter
    readonly #successor: ValueEventBoxAdapter
    readonly #collection: ValueEventCollectionBoxAdapter

    readonly #notifier: Notifier<void>

    readonly #y0: number
    readonly #y1: number
    readonly #initialMidY: number

    #slope: unitValue
    #pointerY: number = NaN

    private constructor({element, valueAxis, reference, collection}: Construct) {
        this.#element = element
        this.#reference = reference
        this.#successor = ValueEvent.nextEvent<ValueEventBoxAdapter>(collection.events, reference)
            ?? panic("No successor event")
        this.#collection = collection

        this.#notifier = new Notifier<void>()

        const interpolation = reference.interpolation
        this.#slope = interpolation.type === "curve" ? interpolation.slope : 0.5
        this.#y0 = valueAxis.valueToAxis(reference.value)
        this.#y1 = valueAxis.valueToAxis(this.#successor.value)
        this.#initialMidY = Curve.normalizedAt(0.5, this.#slope) * (this.#y1 - this.#y0) + this.#y0
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
        if (Number.isNaN(this.#pointerY)) {this.#pointerY = localY}
        const deltaY = (localY - this.#pointerY) * (altKey ? 0.1 : 1.0)
        const targetY = this.#initialMidY + deltaY
        let slope = clampUnit(Curve.slopeByHalf(this.#y0, targetY, this.#y1))
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