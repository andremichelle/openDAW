import {
    assert,
    DefaultObservableValue,
    int,
    MutableObservableOption,
    ObservableOption,
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
import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"

export class ParameterValueEditing implements ValueContext, Terminable {
    static readonly FallbackStringMapping = StringMapping.percent()

    static snapToSteps(value: unitValue, steps: int): unitValue {
        return steps < 2 ? value : Math.round(value * (steps - 1)) / (steps - 1)
    }

    readonly #terminator = new Terminator()

    readonly #anchorValue: DefaultObservableValue<unitValue>
    readonly #assignmentLifecycle = new Terminator()
    readonly #assignment: MutableObservableOption<ValueAssignment>
    readonly #track: MutableObservableOption<TrackBoxAdapter>
    readonly #steps: DefaultObservableValue<int>

    constructor(project: Project, collection: PointerField<Pointers.RegionCollection | Pointers.ClipCollection>) {
        this.#anchorValue = new DefaultObservableValue<unitValue>(0.0)
        this.#assignmentLifecycle = this.#terminator.own(new Terminator())
        this.#assignment = this.#terminator.own(new MutableObservableOption<ValueAssignment>())
        this.#track = this.#terminator.own(new MutableObservableOption<TrackBoxAdapter>())
        this.#steps = this.#terminator.own(new DefaultObservableValue<int>(0))
        this.#terminator.own(collection.catchupAndSubscribe(({targetVertex}) => {
            this.#assignmentLifecycle.terminate()
            if (targetVertex.isEmpty()) {
                this.#assignment.clear()
                this.#track.clear()
                this.#steps.setValue(0)
                return // No track assigned
            }
            const boxAdapters = project.boxAdapters
            const trackBoxAdapter = boxAdapters.adapterFor(targetVertex.unwrap().box, TrackBoxAdapter)
            assert(trackBoxAdapter.type === TrackType.Value, "ValueEditorHeader only accepts value tracks")
            this.#track.wrap(trackBoxAdapter)
            this.#assignmentLifecycle.own(trackBoxAdapter.box.valueSteps
                .catchupAndSubscribe(field => this.#steps.setValue(field.getValue())))
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

    get track(): ObservableOption<TrackBoxAdapter> {return this.#track}
    get stepsModel(): ObservableValue<int> {return this.#steps}

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
            none: () => ParameterValueEditing.FallbackStringMapping,
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
                return mapping.x(mapping.y(ParameterValueEditing.snapToSteps(value, this.#steps.getValue())))
            }
        })
    }

    terminate(): void {this.#terminator.terminate()}
}