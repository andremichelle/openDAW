import {Editing, MutableObservableValue, Observer, ObservableValue, Procedure, Provider, Subscription} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"

export type ExclusiveSoloControl = {
    readonly model: MutableObservableValue<boolean>
    readonly onInit: Procedure<HTMLElement>
}

export namespace ExclusiveSolo {
    // soloing a unit releases every other solo, unless shift is held while clicking
    export const create = (editing: Editing, unit: AudioUnitBoxAdapter,
                           units: Provider<ReadonlyArray<AudioUnitBoxAdapter>>): ExclusiveSoloControl => {
        const {solo} = unit.namedParameter
        const modifier = {shift: false}
        const model = new class implements MutableObservableValue<boolean> {
            getValue(): boolean {return solo.getControlledValue()}
            setValue(value: boolean): void {
                editing.modify(() => {
                    solo.setValue(value)
                    if (value && !modifier.shift) {
                        units().filter(other => other !== unit).forEach(other => other.box.solo.setValue(false))
                    }
                })
            }
            subscribe(observer: Observer<ObservableValue<boolean>>): Subscription {return solo.subscribe(() => observer(this))}
            catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
                return solo.catchupAndSubscribe(observer)
            }
        }
        const onInit = (element: HTMLElement) =>
            element.addEventListener("click", (event: MouseEvent) => modifier.shift = event.shiftKey, {capture: true})
        return {model, onInit}
    }
}
