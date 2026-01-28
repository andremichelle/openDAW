import {
    Arrays,
    Cache,
    Comparator,
    int,
    Option,
    panic,
    Selectable,
    Terminable,
    Terminator,
    unitValue,
    UUID
} from "@moises-ai/lib-std"
import {Interpolation, ppqn, ValueEvent} from "@moises-ai/lib-dsp"
import {Address, Field, Propagation, Update} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {ValueEventBox} from "@moises-ai/studio-boxes"
import {ValueEventCollectionBoxAdapter} from "../collection/ValueEventCollectionBoxAdapter"
import {BoxAdapter} from "../../BoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {InterpolationFieldAdapter} from "./InterpolationFieldAdapter"

type CopyToParams = {
    position?: ppqn,
    index?: int,
    value?: unitValue,
    interpolation?: Interpolation,
    events?: Field<Pointers.ValueEvents>
}

export class ValueEventBoxAdapter implements ValueEvent, BoxAdapter, Selectable {
    static readonly Comparator: Comparator<ValueEventBoxAdapter> = (a, b) => {
        if (a === b) {return panic(`${a} is equal to itself`)}
        const positionDiff = a.position - b.position
        if (positionDiff !== 0) {return positionDiff}
        const indexDiff = a.index - b.index
        if (indexDiff !== 0) {return indexDiff}
        return panic(`${a} and ${b} are identical in terms of comparison`)
    }

    readonly type = "value-event"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: ValueEventBox

    readonly #interpolation: Cache<Interpolation>

    #interpolationSubscription: Terminable
    #isSelected: boolean = false

    constructor(context: BoxAdaptersContext, box: ValueEventBox) {
        this.#context = context
        this.#box = box

        this.#interpolation = this.#terminator.own(new Cache<Interpolation>(() =>
            InterpolationFieldAdapter.read(this.#box.interpolation)))

        const invalidateInterpolation = () => {
            this.#interpolation.invalidate()
            this.collection.ifSome(collection => collection.onEventPropertyChanged())
        }
        this.#terminator.ownAll(
            this.#box.subscribe(Propagation.Children, (update: Update) => {
                if (this.collection.isEmpty()) {return}
                if (update.type === "primitive" || update.type === "pointer") {
                    const collection = this.collection.unwrap()
                    const updatedFieldKeys = update.address.fieldKeys
                    const indexChanged = Arrays.equals(this.#box.index.address.fieldKeys, updatedFieldKeys)
                    const positionChanged = Arrays.equals(this.#box.position.address.fieldKeys, updatedFieldKeys)
                    if (indexChanged || positionChanged) {
                        collection.requestSorting()
                    } else {
                        collection.onEventPropertyChanged()
                    }
                }
            }),
            this.#box.interpolation.subscribe(invalidateInterpolation),
            this.#box.interpolation.pointerHub.subscribe({
                onAdded: ({box}) => {
                    this.#interpolationSubscription.terminate()
                    this.#interpolationSubscription = box.subscribe(Propagation.Children, invalidateInterpolation)
                    invalidateInterpolation()
                },
                onRemoved: () => {
                    this.#interpolationSubscription.terminate()
                    this.#interpolationSubscription = Terminable.Empty
                    invalidateInterpolation()
                }
            })
        )

        this.#interpolationSubscription = this.#box.interpolation.pointerHub
                .filter(Pointers.ValueInterpolation)
                .at(0)?.box
                .subscribe(Propagation.Children, invalidateInterpolation)
            ?? Terminable.Empty
    }

    onSelected(): void {
        this.#isSelected = true
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }
    onDeselected(): void {
        this.#isSelected = false
        this.collection.ifSome(region => region.onEventPropertyChanged())
    }

    terminate(): void {
        this.#interpolationSubscription.terminate()
        this.#terminator.terminate()
    }

    get box(): ValueEventBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): int {return this.#box.position.getValue()}
    get index(): int {return this.#box.index.getValue()}
    set interpolation(value: Interpolation) {InterpolationFieldAdapter.write(this.#box.interpolation, value)}
    get interpolation(): Interpolation {return this.#interpolation.get()}
    get value(): number {return this.#box.value.getValue()}
    get isSelected(): boolean {return this.#isSelected}
    get collection(): Option<ValueEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, ValueEventCollectionBoxAdapter))
    }

    copyTo(options?: CopyToParams): ValueEventBoxAdapter {
        const position = options?.position ?? this.position
        const index = options?.index ?? this.index
        const eventBox = ValueEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.index.setValue(index)
            box.events.refer(options?.events ?? this.collection.unwrap().box.events)
            box.value.setValue(options?.value ?? this.value)
        })
        InterpolationFieldAdapter.write(eventBox.interpolation, options?.interpolation ?? this.interpolation)
        return this.#context.boxAdapters.adapterFor(eventBox, ValueEventBoxAdapter)
    }

    copyFrom(options?: CopyToParams): this {
        this.#box.position.setValue(options?.position ?? this.position)
        this.#box.index.setValue(options?.index ?? this.index)
        this.#box.events.refer(options?.events ?? this.collection.unwrap().box.events)
        this.#box.value.setValue(options?.value ?? this.value)
        InterpolationFieldAdapter.write(this.#box.interpolation, options?.interpolation ?? this.interpolation)
        return this
    }

    toString(): string {return `{ValueEventBoxAdapter position: ${this.position} index: ${this.index}}`}
}