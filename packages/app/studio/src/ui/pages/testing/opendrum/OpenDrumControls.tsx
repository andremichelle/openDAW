import {clamp, DefaultObservableValue, Func, int, isDefined, Lifecycle, Notifier, Optional, Procedure, Provider} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {MenuButton} from "@/ui/components/MenuButton"
import {MenuItem} from "@opendaw/studio-core"
import {SamplerValueLabel} from "@/ui/devices/instruments/SamplerDeviceEditor/SamplerValueLabel"

export namespace OpenDrumControls {
    export type Printed = readonly [value: string, unit: string]
    export type Format = {
        readonly print: Func<number, Printed>
        // `shown` is the unit on display, a number typed without a unit is read in it
        readonly parse: (text: string, shown: string) => Optional<number>
    }
    export type Field = {
        readonly name: string
        readonly get: Provider<number>
        readonly set: Procedure<number>
        readonly range?: { readonly min: number, readonly max: number, readonly step: number, readonly format: Format }
        readonly choices?: ReadonlyArray<string>
    }

    const {numberIn} = SamplerValueLabel
    const scaled = (factor: number): Func<string, Optional<number>> => text => {
        const parsed = numberIn(text)
        return isDefined(parsed) ? parsed * factor : undefined
    }

    export const Formats = {
        integer: (unit: string): Format => ({print: value => [String(Math.round(value)), unit], parse: numberIn}),
        fixed: (digits: int, unit: string): Format => ({print: value => [value.toFixed(digits), unit], parse: numberIn}),
        percent: {print: value => [String(Math.round(value * 100)), "%"], parse: scaled(0.01)} satisfies Format,
        millis: {print: value => [value.toFixed(1), "ms"], parse: numberIn} satisfies Format,
        decibel: {print: value => [value.toFixed(1), "dB"], parse: numberIn} satisfies Format,
        seconds: {
            print: value => value < 1.0 ? [String(Math.round(value * 1000)), "ms"] : [value.toFixed(2), "s"],
            parse: (text, shown) => {
                const unit = /ms/i.test(text) ? "ms" : /s/i.test(text) ? "s" : shown
                return scaled(unit === "ms" ? 0.001 : 1.0)(text)
            }
        } satisfies Format,
        hertz: {
            print: value => value < 1000.0 ? [String(Math.round(value)), "Hz"] : [(value / 1000).toFixed(1), "kHz"],
            parse: (text, shown) => {
                const unit = /k/i.test(text) ? "kHz" : /hz/i.test(text) ? "Hz" : shown
                return scaled(unit === "kHz" ? 1000.0 : 1.0)(text)
            }
        } satisfies Format
    }

    const value = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field,
                   {min, max, step, format}: NonNullable<Field["range"]>): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        const update = () => {
            const [text, unit] = format.print(field.get())
            label.textContent = text
            if (unit.length > 0) {label.setAttribute("unit", unit)} else {label.removeAttribute("unit")}
        }
        let drag: Optional<{ readonly y: number, readonly value: number }> = undefined
        lifecycle.ownAll(
            refresh.subscribe(update),
            Events.subscribe(label, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0) {return}
                label.setPointerCapture(event.pointerId)
                label.classList.add("modifying")
                drag = {y: event.clientY, value: field.get()}
            }),
            Events.subscribe(label, "pointermove", (event: PointerEvent) => {
                if (!isDefined(drag)) {return}
                const next = clamp(drag.value + Math.round((drag.y - event.clientY) / 2) * step, min, max)
                if (next === field.get()) {return}
                field.set(next)
                refresh.notify()
            }),
            Events.subscribe(label, "pointerup", () => {
                label.classList.remove("modifying")
                drag = undefined
            }),
            Events.subscribeDblDwn(label, async event => {
                label.classList.remove("modifying")
                drag = undefined
                const [text, unit] = format.print(field.get())
                const typed = await SamplerValueLabel.ask(label, event, unit.length > 0 ? `${text} ${unit}` : text)
                if (typed.isEmpty()) {return}
                const parsed = format.parse(typed.unwrap(), unit)
                if (!isDefined(parsed) || !Number.isFinite(parsed)) {return}
                field.set(clamp(parsed, min, max))
                refresh.notify()
            })
        )
        update()
        return label
    }

    const choice = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field,
                    names: ReadonlyArray<string>): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        lifecycle.own(refresh.subscribe(() => label.textContent = names[field.get()]))
        label.textContent = names[field.get()]
        return (
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent =>
                names.forEach((name, index) => parent.addMenuItem(MenuItem.default({label: name, checked: index === field.get()})
                    .setTriggerProcedure(() => {
                        field.set(index)
                        refresh.notify()
                    }))))} appearance={{color: Colors.gray, activeColor: Colors.bright}}>{label}</MenuButton>
        )
    }

    const toggle = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field): JsxValue => {
        const model = lifecycle.own(new DefaultObservableValue(field.get() === 1))
        lifecycle.ownAll(
            refresh.subscribe(() => model.setValue(field.get() === 1)),
            model.subscribe(owner => {
                if ((field.get() === 1) === owner.getValue()) {return}
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

    const cell = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field): HTMLElement => {
        const {name, range, choices} = field
        if (isDefined(range)) {
            return <div className="cell"><div className="name">{name}</div>{value(lifecycle, refresh, field, range)}</div>
        }
        if (isDefined(choices)) {
            return <div className="cell"><div className="name">{name}</div>{choice(lifecycle, refresh, field, choices)}</div>
        }
        const flip = (): void => {
            field.set(field.get() === 1 ? 0 : 1)
            refresh.notify()
        }
        return <div className="cell"><div className="name switch" onclick={flip}>{name}</div>{toggle(lifecycle, refresh, field)}</div>
    }

    export const group = (lifecycle: Lifecycle, refresh: Notifier<void>, color: string, heading: string, columns: int,
                          fields: ReadonlyArray<Field>): HTMLElement => (
        <div className={`parameter-group ${color} columns-${columns}`}>
            <div className="label">{heading}</div>
            {fields.map(field => cell(lifecycle, refresh, field))}
        </div>
    )
}
