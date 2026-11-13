import {clamp, Func, isDefined, Lifecycle, Notifier, Optional, Procedure, Provider} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {SamplerValueLabel} from "@/ui/devices/instruments/SamplerDeviceEditor/SamplerValueLabel"

export namespace SurgeonControls {
    export type Printed = readonly [value: string, unit: string]
    export type Field = {
        readonly min: number
        readonly max: number
        readonly step: number
        readonly print: Func<number, Printed>
        readonly parse: Func<string, Optional<number>>
        readonly get: Provider<number>
        readonly set: Procedure<number>
        readonly decorate?: (label: HTMLElement, value: number) => void
    }

    const PixelsPerStep = 2
    const DeadZone = 3
    const {numberIn} = SamplerValueLabel
    const scaled = (factor: number): Func<string, Optional<number>> => text => {
        const parsed = numberIn(text)
        return isDefined(parsed) ? parsed * factor : undefined
    }

    export const Prints = {
        integer: (value: number): Printed => [String(Math.round(value)), ""],
        fixed: (value: number): Printed => [value.toFixed(2), ""],
        percent: (value: number): Printed => [String(Math.round(value * 100)), "%"],
        millis: (value: number): Printed => [String(Math.round(value * 1000)), "ms"],
        octaves: (value: number): Printed => [(value / 12).toFixed(2), "oct"],
        hertz: (value: number): Printed => [(440.0 * Math.pow(2.0, (value - 69.0) / 12.0)).toFixed(1), "Hz"],
        decibel: (value: number): Printed => [value.toFixed(1), "dB"]
    }
    export const Parses = {
        plain: numberIn,
        percent: scaled(0.01),
        millis: scaled(0.001),
        octaves: scaled(12.0),
        hertz: (text: string): Optional<number> => {
            const parsed = numberIn(text)
            return isDefined(parsed) && parsed > 0.0 ? 69.0 + 12.0 * Math.log2(parsed / 440.0) : undefined
        }
    }

    // a value shown like a parameter label: drag up or down to change, double click to type
    export const value = (lifecycle: Lifecycle, refresh: Notifier<void>, field: Field): HTMLElement => {
        const {min, max, step, print, parse, get, set, decorate} = field
        const label: HTMLElement = <label className="value"/>
        const update = () => {
            const [text, unit] = print(get())
            label.textContent = text
            if (unit.length > 0) {label.setAttribute("unit", unit)} else {label.removeAttribute("unit")}
            decorate?.(label, get())
        }
        let drag: Optional<{ y: number, readonly value: number, moved: boolean }> = undefined
        const release = () => {
            label.classList.remove("modifying")
            drag = undefined
        }
        lifecycle.ownAll(
            refresh.subscribe(update),
            Events.subscribe(label, "pointerdown", (event: PointerEvent) => {
                if (event.button !== 0) {return}
                label.setPointerCapture(event.pointerId)
                label.classList.add("modifying")
                drag = {y: event.clientY, value: get(), moved: false}
            }),
            Events.subscribe(label, "pointermove", (event: PointerEvent) => {
                if (!isDefined(drag)) {return}
                if (!drag.moved) {
                    const slipped = drag.y - event.clientY
                    if (Math.abs(slipped) < DeadZone) {return}
                    drag.y -= Math.sign(slipped) * DeadZone
                    drag.moved = true
                }
                const next = clamp(drag.value + Math.round((drag.y - event.clientY) / PixelsPerStep) * step, min, max)
                if (next === get()) {return}
                set(next)
                refresh.notify()
            }),
            Events.subscribe(label, "pointerup", release),
            Events.subscribe(label, "pointercancel", release),
            Events.subscribeDblDwn(label, async event => {
                release()
                const [text, unit] = print(get())
                const typed = await SamplerValueLabel.ask(label, event, unit.length > 0 ? `${text} ${unit}` : text)
                if (typed.isEmpty()) {return}
                const parsed = parse(typed.unwrap())
                if (!isDefined(parsed) || !Number.isFinite(parsed)) {return}
                set(clamp(parsed, min, max))
                refresh.notify()
            })
        )
        update()
        return label
    }

    export const choice = (lifecycle: Lifecycle, refresh: Notifier<void>, names: ReadonlyArray<string>,
                           get: Provider<number>, set: Procedure<number>): HTMLElement =>
        SamplerValueLabel.choice(lifecycle, observer => refresh.subscribe(observer), {
            names, get, set: index => {
                set(index)
                refresh.notify()
            }
        })

    // caption over a value, the label control of Vaporisateur and Tubular
    export const control = (caption: string, child: JsxValue, gridArea?: string, color?: string): HTMLElement => (
        <div className="control" style={isDefined(gridArea) ? {gridArea} : {}}>
            <h3 style={isDefined(color) ? {color} : {}}>{caption}</h3>
            {child}
        </div>
    )

    export const button = (lifecycle: Lifecycle, label: string, action: Procedure<void>, gridArea?: string,
                           group?: string): HTMLElement => {
        const element: HTMLElement = (
            <div className={isDefined(group) ? `button ${group}` : "button"} style={isDefined(gridArea) ? {gridArea} : {}}>{label}</div>
        )
        lifecycle.own(Events.subscribe(element, "click", () => action()))
        return element
    }
}
