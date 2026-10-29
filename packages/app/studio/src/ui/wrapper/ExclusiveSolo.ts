import {Editing, MutableObservableValue, Observer, ObservableValue, Procedure, Provider, Subscription} from "@opendaw/lib-std"
import {PrimitiveField} from "@opendaw/lib-box"
import {AudioUnitBoxAdapter, AutomatableParameterFieldAdapter, CompositeCell} from "@opendaw/studio-adapters"

export type ExclusiveSoloControl = {
    readonly model: MutableObservableValue<boolean>
    readonly onInit: Procedure<HTMLElement>
}

export namespace ExclusiveSolo {
    // soloing a unit releases every other solo, unless shift is held while clicking
    export const create = (editing: Editing, unit: AudioUnitBoxAdapter,
                           units: Provider<ReadonlyArray<AudioUnitBoxAdapter>>): ExclusiveSoloControl =>
        forParameter(editing, unit.namedParameter.solo,
            () => units().filter(other => other !== unit).map(other => other.box.solo))

    // the same among the layers or entries of one composite
    export const forCell = (editing: Editing, cell: CompositeCell): ExclusiveSoloControl =>
        forParameter(editing, cell.namedParameter.solo,
            () => cell.siblings().filter(other => other !== cell).map(other => other.namedParameter.solo.field))

    const forParameter = (editing: Editing, solo: AutomatableParameterFieldAdapter<boolean>,
                          others: Provider<ReadonlyArray<PrimitiveField<boolean, any>>>): ExclusiveSoloControl => {
        const modifier = {shift: false}
        const model = new class implements MutableObservableValue<boolean> {
            getValue(): boolean {return solo.getControlledValue()}
            setValue(value: boolean): void {
                editing.modify(() => {
                    solo.setValue(value)
                    if (value && !modifier.shift) {
                        others().forEach(other => other.setValue(false))
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
