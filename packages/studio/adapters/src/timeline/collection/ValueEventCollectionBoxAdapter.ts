import {BoxVisitor, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {
    asDefined,
    Curve,
    int,
    isDefined,
    linear,
    Notifier,
    Observer,
    Option,
    panic,
    SortedSet,
    Subscription,
    Terminator,
    unitValue,
    UUID,
    ValueMapping
} from "@opendaw/lib-std"
import {Address, Box} from "@opendaw/lib-box"
import {EventCollection, Interpolation, ppqn, ValueEvent} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {BoxAdapter} from "../../BoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ValueEventBoxAdapter} from "../event/ValueEventBoxAdapter"
import {InterpolationFieldAdapter} from "../event/InterpolationFieldAdapter"

type CreateEventParams = {
    position: ppqn,
    index: int,
    value: unitValue,
    interpolation: Interpolation
}

export class ValueEventCollectionBoxAdapter implements BoxAdapter {
    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: ValueEventCollectionBox

    readonly #changeNotifier: Notifier<this>
    readonly #adapters: SortedSet<UUID.Bytes, ValueEventBoxAdapter>
    readonly #events: EventCollection<ValueEventBoxAdapter>

    constructor(context: BoxAdaptersContext, box: ValueEventCollectionBox) {
        this.#context = context
        this.#box = box

        this.#changeNotifier = new Notifier<this>()
        this.#adapters = UUID.newSet(adapter => adapter.uuid)
        this.#events = EventCollection.create(ValueEventBoxAdapter.Comparator)

        const addValueProcedure = (box: Box) => {
            const adapter = asDefined(box.accept<BoxVisitor<ValueEventBoxAdapter>>({
                visitValueEventBox: (box: ValueEventBox) => this.#context.boxAdapters.adapterFor(box, ValueEventBoxAdapter)
            }), `Could not find adapter for ${box}`)
            if (this.#adapters.add(adapter)) {
                this.#events.add(adapter)
                this.#onEventsChanged()
            }
        }
        this.#box.events.pointerHub.incoming().forEach(({box}) => addValueProcedure(box))
        this.#terminator.own(this.#box.events.pointerHub.subscribe({
            onAdded: ({box}) => addValueProcedure(box),
            onRemoved: ({box: {address: {uuid}}}) => {
                this.#events.remove(this.#adapters.removeByKey(uuid))
                this.#onEventsChanged()
            }
        }))
        this.#terminator.own(this.#box.owners.pointerHub.subscribe({
            onAdded: () => this.#changeNotifier.notify(this),
            onRemoved: () => this.#changeNotifier.notify(this)
        }))
    }

    valueAt(position: ppqn, fallback: unitValue): unitValue {return ValueEvent.valueAt(this.#events, position, fallback)}

    copy(): ValueEventCollectionBoxAdapter {
        const graph = this.#context.boxGraph
        const boxCopy = ValueEventCollectionBox.create(graph, UUID.generate())
        this.#events.asArray().forEach(source => source.copyTo({events: boxCopy.events}))
        return this.#context.boxAdapters.adapterFor(boxCopy, ValueEventCollectionBoxAdapter)
    }

    cut(position: ppqn, eventMapping: ValueMapping<number> = ValueMapping.unipolar()): Option<ValueEventBoxAdapter> {
        const low = this.events.lowerEqual(position)
        const high = this.events.greaterEqual(position)
        if (null === high) {
            if (null === low) {return Option.None}
            return Option.wrap(this.createEvent({
                position,
                value: low.value,
                index: low.index,
                interpolation: low.interpolation
            }))
        }
        if (null === low) {
            return Option.wrap(this.createEvent({
                position,
                value: high.value,
                index: high.index,
                interpolation: high.interpolation
            }))
        }
        if (low.position === position) {return Option.wrap(low)}
        if (high.position === position) {return Option.wrap(high)}
        if (low.interpolation.type === "none") {
            return Option.wrap(this.createEvent({
                position,
                value: low.value,
                index: low.index,
                interpolation: low.interpolation
            }))
        }
        if (low.interpolation.type === "linear") {
            const {position: p0} = low
            const {position: p1} = high
            // Convert to normalized space for interpolation
            const n0 = eventMapping.x(low.value)
            const n1 = eventMapping.x(high.value)
            const normalizedValue = linear(n0, n1, (position - p0) / (p1 - p0))
            return Option.wrap(this.createEvent({
                position,
                value: eventMapping.y(normalizedValue),
                index: 0,
                interpolation: low.interpolation
            }))
        }
        if (low.interpolation.type === "curve") {
            const {position: p0} = low
            const {position: p1} = high
            // Convert to normalized space for curve calculation
            const y0 = eventMapping.x(low.value)
            const y1 = eventMapping.x(high.value)
            const steps = p1 - p0
            const cutOffset = position - p0
            const curve = Curve.byHalf(steps, y0, Curve.valueAt({
                slope: low.interpolation.slope,
                steps,
                y0,
                y1
            }, steps * 0.5), y1)
            const cutValue = Curve.valueAt(curve, cutOffset)
            const lowSlope = Curve.slopeByHalf(y0, Curve.valueAt(curve, cutOffset * 0.5), cutValue)
            InterpolationFieldAdapter.write(low.box.interpolation, Interpolation.Curve(lowSlope))
            return Option.wrap(this.createEvent({
                position,
                value: eventMapping.y(cutValue),
                index: 0,
                interpolation: Interpolation.Curve(Curve.slopeByHalf(cutValue, Curve.valueAt(curve, (cutOffset + steps) * 0.5), y1))
            }))
        }
        return panic("Unknown interpolation type")
    }

    subscribeChange(observer: Observer<this>): Subscription {return this.#changeNotifier.subscribe(observer)}

    createEvent({position, index, value, interpolation}: CreateEventParams): ValueEventBoxAdapter {
        const intPosition = Math.trunc(position)
        const existing = this.#adapters.values().find(event => event.position === intPosition && event.index === index)
        // the adapters might be out of sync until the current transaction ends. Therefore, we check with isAttached.
        if (isDefined(existing) && existing.box.isAttached()) {
            // Return an existing event instead of creating a duplicate-update its value
            existing.box.value.setValue(value)
            InterpolationFieldAdapter.write(existing.box.interpolation, interpolation)
            return existing
        }
        const eventBox = ValueEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.index.setValue(index)
            box.value.setValue(value)
            box.events.refer(this.#box.events)
        })
        InterpolationFieldAdapter.write(eventBox.interpolation, interpolation)
        return this.#context.boxAdapters.adapterFor(eventBox, ValueEventBoxAdapter)
    }

    requestSorting(): void {
        this.#events.onIndexingChanged()
        this.onEventPropertyChanged()
    }

    onEventPropertyChanged(): void {this.#onEventsChanged()}

    terminate() {this.#terminator.terminate()}

    get box(): ValueEventCollectionBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get numOwners(): int {return this.#box.owners.pointerHub.filter(Pointers.ValueEventCollection).length}
    get events(): EventCollection<ValueEventBoxAdapter> {return this.#events}

    toString(): string {return `{ValueEventCollectionBox ${UUID.toString(this.#box.address.uuid)}}`}

    #onEventsChanged(): void {this.#changeNotifier.notify(this)}
}