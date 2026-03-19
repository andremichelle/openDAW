import {AutomatableParameterFieldAdapter} from "@moises-ai/studio-adapters"
import {PrimitiveValues} from "@moises-ai/lib-box"
import {Editing, MutableObservableValue, ObservableValue, Observer, Subscription} from "@moises-ai/lib-std"

export namespace EditWrapper {
    export const forValue = <T extends PrimitiveValues>(
        editing: Editing, owner: MutableObservableValue<T>): MutableObservableValue<T> =>
        new class implements MutableObservableValue<T> {
            getValue(): T {return owner.getValue()}
            setValue(value: T) {
                editing.modify(() => owner.setValue(value), false)
            }
            subscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return owner.subscribe(() => observer(this))
            }
            catchupAndSubscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return owner.catchupAndSubscribe(observer)
            }
        }

    export const forAutomatableParameter = <T extends PrimitiveValues>(
        editing: Editing,
        adapter: AutomatableParameterFieldAdapter<T>): MutableObservableValue<T> =>
        new class implements MutableObservableValue<T> {
            getValue(): T {return adapter.getControlledValue()}
            setValue(value: T) {
                editing.modify(() => adapter.setValue(value))
            }
            subscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return adapter.subscribe(() => observer(this))
            }
            catchupAndSubscribe(observer: Observer<ObservableValue<T>>): Subscription {
                return adapter.catchupAndSubscribe(observer)
            }
        }
}