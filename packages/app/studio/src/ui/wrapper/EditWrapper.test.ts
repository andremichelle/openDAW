import {describe, expect, it} from "vitest"
import {Editing, Notifier, Observer, Option, Subscription} from "@opendaw/lib-std"
import {AutomatableParameterFieldAdapter} from "@opendaw/studio-adapters"
import {EditWrapper} from "./EditWrapper"

// A boolean parameter whose stored field and engine-controlled (automated) value can differ.
class ParameterStub {
    readonly notifier = new Notifier<ParameterStub>()
    stored = true
    controlled = true
    writes = 0
    getValue(): boolean {return this.stored}
    getControlledValue(): boolean {return this.controlled}
    setValue(value: boolean): void {
        this.writes++
        this.stored = value
        this.notifier.notify(this)
    }
    subscribe(observer: Observer<ParameterStub>): Subscription {return this.notifier.subscribe(observer)}
    catchupAndSubscribe(observer: Observer<ParameterStub>): Subscription {
        observer(this)
        return this.subscribe(observer)
    }
    engineReports(value: boolean): void {
        this.controlled = value
        this.notifier.notify(this)
    }
}

class EditingStub {
    modifications = 0
    modify<R>(modifier: () => R): Option<R> {
        this.modifications++
        return Option.wrap(modifier())
    }
}

const setup = () => {
    const parameter = new ParameterStub()
    const editing = new EditingStub()
    const model = EditWrapper.forAutomatableParameter(editing as unknown as Editing,
        parameter as unknown as AutomatableParameterFieldAdapter<boolean>)
    return {parameter, editing, model}
}

describe("EditWrapper.forAutomatableParameter", () => {
    it("reads the engine-controlled value, not the stored field", () => {
        const {parameter, model} = setup()
        parameter.engineReports(false)
        expect(model.getValue()).toBe(false)
        expect(parameter.getValue()).toBe(true)
    })

    // Regression: the FX Composite send / entry mute / Playfield pad checkboxes echoed every automated value
    // back into the field. Each echo was an edit, which suspends the automation lane (#347) while playing,
    // so the send stopped following its curve.
    it("an automated value reaching a control never writes the field", () => {
        const {parameter, editing, model} = setup()
        const seen: Array<boolean> = []
        const subscription = model.subscribe(owner => seen.push(owner.getValue()))
        parameter.engineReports(false)
        parameter.engineReports(true)
        parameter.engineReports(false)
        subscription.terminate()
        expect(seen).toEqual([false, true, false])
        expect(editing.modifications).toBe(0)
        expect(parameter.writes).toBe(0)
        expect(parameter.getValue()).toBe(true)
    })

    it("a user toggle writes the field in one edit", () => {
        const {parameter, editing, model} = setup()
        model.setValue(false)
        expect(editing.modifications).toBe(1)
        expect(parameter.writes).toBe(1)
        expect(parameter.getValue()).toBe(false)
    })
})
