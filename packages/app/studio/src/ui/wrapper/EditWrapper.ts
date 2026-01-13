import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {BoxEditing, PrimitiveValues} from "@moises-ai/lib-box"
import {MutableObservableValue, ObservableValue, Observer, Subscription} from "@moises-ai/lib-std"

export namespace EditWrapper {
    export const forValue = <T extends PrimitiveValues>(
        editing: BoxEditing, owner: MutableObservableValue<T>): MutableObservableValue<T> =>
        new class implements MutableObservableValue<T> {
            getValue(): T {return owner.getValue()}
            setValue(value: T) {
                if (editing.mustModify()) {
                    editing.modify(() => owner.setValue(value), false)
                } else {
                    owner.setValue(value)
                }
            }
            subscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return owner.subscribe(() => observer(this))
            }
            catchupAndSubscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return owner.catchupAndSubscribe(observer)
            }
        }

    export const forAutomatableParameter = <T extends PrimitiveValues>(
        editing: BoxEditing,
        adapter: AutomatableParameterFieldAdapter<T>): MutableObservableValue<T> =>
        new class implements MutableObservableValue<T> {
            getValue(): T {return adapter.getControlledValue()}
            setValue(value: T) {
                if (editing.mustModify()) {
                    editing.modify(() => adapter.setValue(value))
                } else {
                    adapter.setValue(value)
                }
            }
            subscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return adapter.subscribe(() => observer(this))
            }
            catchupAndSubscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return adapter.catchupAndSubscribe(observer)
            }
        }
}