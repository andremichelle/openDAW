import {
    assert,
    DefaultObservableValue,
    MutableObservableOption,
    ObservableValue,
    Observer,
    Option,
    StringMapping,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    ValueMapping
} from "@opendaw/lib-std"
import {ValueAssignment} from "@/ui/timeline/editors/value/ValueAssignment.tsx"
import {PointerField, PrimitiveValues} from "@opendaw/lib-box"
import {TrackBoxAdapter, TrackType} from "@opendaw/studio-adapters"
import {Pointers} from "@opendaw/studio-enums"
import {Project} from "@opendaw/studio-core"

export interface ValueEditing {
    readonly anchorModel: ObservableValue<unitValue>
    readonly stringMapping: StringMapping<PrimitiveValues>
    readonly currentValue: unitValue
    readonly floating: boolean
    quantize(value: unitValue): unitValue
}

export class ValueEditingContext implements ValueEditing, Terminable {
    static readonly FallbackStringMapping = StringMapping.percent()

    readonly #terminator = new Terminator()

    readonly #anchorValue: DefaultObservableValue<unitValue>
    readonly #assignmentLifecycle = new Terminator()
    readonly #assignment: MutableObservableOption<ValueAssignment>

    constructor(project: Project, collection: PointerField<Pointers.RegionCollection | Pointers.ClipCollection>) {
        this.#anchorValue = new DefaultObservableValue<unitValue>(0.0)
        this.#assignmentLifecycle = this.#terminator.own(new Terminator())
        this.#assignment = this.#terminator.own(new MutableObservableOption<ValueAssignment>())
        this.#terminator.own(collection.catchupAndSubscribe(({targetVertex}) => {
            this.#assignmentLifecycle.terminate()
            if (targetVertex.isEmpty()) {
                this.#assignment.clear()
                return // No track assigned
            }
            const boxAdapters = project.boxAdapters
            const trackBoxAdapter = boxAdapters.adapterFor(targetVertex.unwrap().box, TrackBoxAdapter)
            assert(trackBoxAdapter.type === TrackType.Value, "ValueEditorHeader only accepts value tracks")
            this.#assignmentLifecycle.own(trackBoxAdapter.target.catchupAndSubscribe((pointer) =>
                this.#assignment.wrapOption(pointer.targetVertex.map(target => {
                    const address = target.address
                    const adapter = project.parameterFieldAdapters.get(address)
                    this.#anchorValue.setValue(adapter.anchor)
                    return {device: undefined, adapter} // TODO Find, observe name
                }))))
        }))
    }

    catchupAndSubscribeValueAssignment(observer: Observer<Option<ValueAssignment>>): Subscription {
        return this.#assignment.catchupAndSubscribe(observer)
    }

    get assignment(): MutableObservableOption<ValueAssignment> {return this.#assignment}

    get anchorModel(): ObservableValue<unitValue> {
        const scope = this
        return new class implements ObservableValue<unitValue> {
            getValue(): unitValue {return scope.#assignment.mapOr(assignment => assignment.adapter.anchor, 0.0)}
            subscribe(observer: Observer<ObservableValue<unitValue>>): Subscription {return scope.#anchorValue.subscribe(observer)}
            catchupAndSubscribe(observer: Observer<ObservableValue<unitValue>>): Subscription {
                observer(this)
                return this.subscribe(observer)
            }
        }
    }

    get valueMapping(): ValueMapping<PrimitiveValues> {
        return this.#assignment.match({
            none: () => ValueMapping.unipolar(),
            some: assignment => assignment.adapter.valueMapping
        })
    }

    get stringMapping(): StringMapping<PrimitiveValues> {
        return this.#assignment.match({
            none: () => ValueEditingContext.FallbackStringMapping,
            some: assignment => assignment.adapter.stringMapping
        })
    }

    get currentValue(): unitValue {
        return this.#assignment.mapOr(assignment => assignment.adapter.getUnitValue(), 0.0)
    }

    get floating(): boolean {
        return this.#assignment.mapOr(assignment => assignment.adapter.valueMapping.floating(), false)
    }

    quantize(value: unitValue): unitValue {
        return this.#assignment.match({
            none: () => value,
            some: assignment => {
                const mapping = assignment.adapter.valueMapping
                return mapping.x(mapping.y(value))
            }
        })
    }

    terminate(): void {this.#terminator.terminate()}
}