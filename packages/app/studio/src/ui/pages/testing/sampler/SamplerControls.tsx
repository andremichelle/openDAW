import {clamp, DefaultObservableValue, Func, int, isDefined, Lifecycle, Notifier, Optional, Procedure, Provider} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"

export namespace SamplerControls {
    export type Printed = readonly [value: string, unit: string]
    export type Field = {
        readonly name: string
        readonly min: number
        readonly max: number
        readonly step: number
        readonly print: Func<number, Printed>
        readonly get: Provider<number>
        readonly set: Procedure<number>
        readonly toggle?: boolean
        readonly available?: Provider<boolean>
    }
    export type Tab = { readonly name: string, readonly fields: ReadonlyArray<Field> }
    export type Tabbed = { readonly element: HTMLElement, readonly tabs: ReadonlyArray<HTMLElement> }

    const names = new WeakMap<Field, Array<HTMLElement>>()

    // lights up the name of a field wherever it is shown
    export const highlight = (field: Field, enabled: boolean): void =>
        names.get(field)?.forEach(name => name.classList.toggle("highlight", enabled))

    export const Print = {
        integer: (unit: string): Func<number, Printed> => value => [String(Math.round(value)), unit],
        fixed: (digits: int, unit: string): Func<number, Printed> => value => [value.toFixed(digits), unit],
        percent: (value: number): Printed => [String(Math.round(value * 100)), "%"],
        key: (value: number): Printed => [MidiKeys.toFullString(Math.round(value)), ""],
        pan: (value: number): Printed =>
            Math.round(value * 100) === 0 ? ["C", ""] : [String(Math.abs(Math.round(value * 100))), value < 0 ? "L" : "R"],
        seconds: (value: number): Printed => value < 1.0 ? [String(Math.round(value * 1000)), "ms"] : [value.toFixed(2), "s"],
        hertz: (value: number): Printed => value < 1000.0 ? [String(Math.round(value)), "Hz"] : [(value / 1000).toFixed(1), "kHz"],
        choice: (options: ReadonlyArray<string>): Func<number, Printed> => value => [options[Math.round(value)], ""]
    }

    export const local = (name: string, initial: number, min: number, max: number, step: number,
                          print: Func<number, Printed>, toggle?: boolean): Field => {
        let current = initial
        return {name, min, max, step, print, toggle, get: () => current, set: value => current = value}
    }

    export const value = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        const update = () => {
            const [text, unit] = field.available?.() === false ? ["–", ""] : field.print(field.get())
            label.textContent = text
            if (unit.length > 0) {label.setAttribute("unit", unit)} else {label.removeAttribute("unit")}
        }
        let drag: Optional<{ readonly y: number, readonly value: number }> = undefined
        lifecycle.ownAll(
            refresh.subscribe(update),
            Events.subscribe(label, "pointerdown", (event: PointerEvent) => {
                if (field.available?.() === false) {return}
                label.setPointerCapture(event.pointerId)
                label.classList.add("modifying")
                drag = {y: event.clientY, value: field.get()}
            }),
            Events.subscribe(label, "pointermove", (event: PointerEvent) => {
                if (!isDefined(drag)) {return}
                const next = clamp(drag.value + Math.round((drag.y - event.clientY) / 2) * field.step, field.min, field.max)
                if (next === field.get()) {return}
                field.set(next)
                refresh.notify()
            }),
            Events.subscribe(label, "pointerup", () => {
                label.classList.remove("modifying")
                drag = undefined
            })
        )
        update()
        return label
    }

    const toggle = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field): JsxValue => {
        const model = lifecycle.own(new DefaultObservableValue(field.get() === 1))
        lifecycle.ownAll(
            refresh.subscribe(() => model.setValue(field.available?.() !== false && field.get() === 1)),
            model.subscribe(owner => {
                if (field.available?.() === false || (field.get() === 1) === owner.getValue()) {return}
                field.set(owner.getValue() ? 1 : 0)
                refresh.notify()
            })
        )
        return (
            <Checkbox lifecycle={lifecycle} model={model} className="toggle"
                      appearance={{color: Colors.shadow, activeColor: Colors.green}}>
                <Icon symbol={IconSymbol.Checkbox}/>
            </Checkbox>
        )
    }

    const cells = (lifecycle: Lifecycle, refresh: Notifier<void>, fields: ReadonlyArray<Field>): ReadonlyArray<JsxValue> =>
        fields.map(field => {
            const name: HTMLElement = <div className="name">{field.name}</div>
            names.set(field, [...names.get(field) ?? [], name])
            return [name, field.toggle === true ? toggle(lifecycle, refresh, field) : value(lifecycle, refresh, field)]
        })

    // one stack whose header switches between parameter sets of the same shape
    export const tabbed = (lifecycle: Lifecycle, refresh: Notifier<void>, color: string, pairs: int,
                           entries: ReadonlyArray<Tab>): Tabbed => {
        const bodies: ReadonlyArray<HTMLElement> = entries.map(({fields}, index) => (
            <div className={Html.buildClassList("body", index > 0 && "hidden")}>{cells(lifecycle, refresh, fields)}</div>
        ))
        const tabs: ReadonlyArray<HTMLElement> = entries.map(({name}, index) => (
            <div className={Html.buildClassList("tab", index === 0 && "active")} onclick={() => {
                tabs.forEach((tab, other) => tab.classList.toggle("active", other === index))
                bodies.forEach((body, other) => body.classList.toggle("hidden", other !== index))
            }}>{name}</div>
        ))
        const element: HTMLElement = (
            <div className={`parameter-stack tabbed ${color} pairs-${pairs}`}>
                <div className="label">{tabs}</div>
                {bodies}
            </div>
        )
        return {element, tabs}
    }

    // fields fill the stack row by row, `pairs` name and value columns per row
    export const stack = (lifecycle: Lifecycle, refresh: Notifier<void>, color: string, heading: string, pairs: int,
                          fields: ReadonlyArray<Field>): HTMLElement => (
        <div className={`parameter-stack ${color} pairs-${pairs}`}>
            <div className="label">{heading}</div>
            {cells(lifecycle, refresh, fields)}
        </div>
    )
}
