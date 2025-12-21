import {
    clampUnit,
    Iterables,
    Notifier,
    Observer,
    Option,
    panic,
    Selection,
    Terminable,
    unitValue,
    ValueAxis,
    ValueMapping
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
    selection: Selection<ValueEventBoxAdapter>
    valueAxis: ValueAxis
    eventMapping: ValueMapping<number>
    pointerValue: unitValue
    collection: ValueEventCollectionBoxAdapter
}>

export class ValueSlopeModifier implements ValueModifier {
    static create(construct: Construct): ValueSlopeModifier {return new ValueSlopeModifier(construct)}

    readonly #element: Element
    readonly #selection: Selection<ValueEventBoxAdapter>
    readonly #valueAxis: ValueAxis
    readonly #eventMapping: ValueMapping<number>
    readonly #pointerValue: unitValue
    readonly #collection: ValueEventCollectionBoxAdapter

    readonly #notifier: Notifier<void>

    #deltaSlope: number

    private constructor({element, selection, valueAxis, eventMapping, pointerValue, collection}: Construct) {
        this.#element = element
        this.#selection = selection
        this.#valueAxis = valueAxis
        this.#eventMapping = eventMapping
        this.#pointerValue = pointerValue
        this.#collection = collection

        this.#notifier = new Notifier<void>()

        this.#deltaSlope = 0.0
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return false}
    snapValue(): Option<unitValue> {return Option.None}
    translateSearch(value: ppqn): ppqn {return value}
    isVisible(_event: ValueEvent): boolean {return true}
    readPosition(event: ValueEvent): ppqn {return event.position}
    readValue(event: ValueEvent): unitValue {return event.value}
    readInterpolation(event: ValueEventBoxAdapter): Interpolation {
        const successor = ValueEvent.nextEvent<ValueEventBoxAdapter>(this.#collection.events, event)
        if (successor === null) {return event.interpolation} // the last event has no successor hence no curve
        const interpolation = event.interpolation
        if (interpolation.type === "none") {
            return Interpolation.None
        } else if (interpolation.type === "linear") {
            return Interpolation.Linear
        } else if (interpolation.type === "curve") {
            const current = this.#eventMapping.x(event.value)
            const next = this.#eventMapping.x(successor.value)
            const slope = clampUnit(interpolation.slope - this.#deltaSlope * Math.sign(current - next))
            return Interpolation.Curve(slope)
        }
        return panic("Internal Error (readInterpolation)")
    }
    readContentDuration(owner: ValueEventOwnerReader): number {return owner.contentDuration}
    iterator(searchMin: ppqn, searchMax: ppqn): IteratorObject<ValueEventDraft> {
        return Iterables.map(ValueEvent.iterateWindow(this.#collection.events, searchMin, searchMax), event => ({
            type: "value-event",
            position: event.position,
            value: event.value,
            interpolation: event.isSelected ? this.readInterpolation(event) : event.interpolation,
            index: event.index,
            isSelected: event.isSelected,
            direction: 0
        }))
    }

    update({clientY}: Dragging.Event): void {
        const clientRect = this.#element.getBoundingClientRect()
        const localY = clientY - clientRect.top
        const deltaSlope: number = this.#eventMapping.x(this.#valueAxis.axisToValue(localY))
            - this.#eventMapping.x(this.#pointerValue)
        if (this.#deltaSlope !== deltaSlope) {
            this.#deltaSlope = deltaSlope
            this.#dispatchChange()
        }
    }

    approve(editing: BoxEditing): void {
        if (this.#deltaSlope === 0.0) {return}
        type Subject = { event: ValueEventBoxAdapter, interpolation: Interpolation }
        const result: ReadonlyArray<Subject> = this.#selection.selected()
            .map(event => ({event, interpolation: this.readInterpolation(event)}))
        editing.modify(() => result.forEach(({event, interpolation}) => event.interpolation = interpolation))
        this.#deltaSlope = 0.0
    }

    cancel(): void {
        this.#deltaSlope = 0.0
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}
}