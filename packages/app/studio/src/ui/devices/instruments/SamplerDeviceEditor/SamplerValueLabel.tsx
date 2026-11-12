import {clamp, Editing, Func, int, isDefined, Lifecycle, Optional, Procedure, Provider, Subscription} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events} from "@opendaw/lib-dom"
import {MenuItem} from "@opendaw/studio-core"
import {Colors} from "@opendaw/studio-enums"
import {MenuButton} from "@/ui/components/MenuButton"
import {Surface} from "@/ui/surface/Surface"

// A value that is a plain box field, not a parameter: shown like a parameter label and dragged to change.
export namespace SamplerValueLabel {
    export type Printed = readonly [value: string, unit: string]
    export type Field = {
        readonly name: string
        readonly min: number
        readonly max: number
        readonly step: number
        readonly print: Func<number, Printed>
        // what a typed text means, undefined when it means nothing
        readonly parse: Func<string, Optional<number>>
        readonly get: Provider<number>
        readonly set: Procedure<number>
        // lowest and highest value when the edited things disagree
        readonly spread?: Provider<Optional<readonly [number, number]>>
        // false while there is nothing to show (no selection)
        readonly available?: Provider<boolean>
    }

    export const Unavailable: Printed = ["–", ""]

    // the first number in a text, whatever unit follows it
    export const numberIn = (text: string): Optional<number> => {
        const match = /-?\d+(?:[.,]\d+)?/.exec(text)
        return isDefined(match) ? parseFloat(match[0].replace(",", ".")) : undefined
    }
    const PixelsPerStep = 2

    export type Choice = {
        readonly names: ReadonlyArray<string>
        readonly get: Provider<int>
        readonly set: Procedure<int>
        readonly available?: Provider<boolean>
    }

    // one of a few named values, picked from a menu
    export const choice = (lifecycle: Lifecycle, observe: Func<Procedure<void>, Subscription>,
                           {names, get, set, available}: Choice): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        const update = (): void => {label.textContent = available?.() === false ? Unavailable[0] : names[get()] ?? ""}
        lifecycle.own(observe(update))
        update()
        return (
            <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => {
                if (available?.() === false) {
                    parent.addMenuItem(MenuItem.default({label: "Select a sample zone first", selectable: false}))
                    return
                }
                names.forEach((name, index) => parent.addMenuItem(MenuItem.default({label: name, checked: index === get()})
                    .setTriggerProcedure(() => set(index))))
            })} appearance={{color: Colors.gray, activeColor: Colors.bright}}>{label}</MenuButton>
        )
    }

    export const create = (lifecycle: Lifecycle, editing: Editing, observe: Func<Procedure<void>, Subscription>,
                           field: Field): HTMLElement => {
        const label: HTMLElement = <label className="value"/>
        const update = (): void => {
            const spread = field.available?.() === false ? undefined : field.spread?.()
            const [text, unit] = field.available?.() === false ? Unavailable : field.print(field.get())
            label.textContent = text
            label.classList.toggle("spread", isDefined(spread))
            label.title = isDefined(spread) ? `${field.print(spread[0]).join(" ").trim()} to ${field.print(spread[1]).join(" ").trim()}` : ""
            if (unit.length > 0) {label.setAttribute("unit", unit)} else {label.removeAttribute("unit")}
        }
        let drag: Optional<{ readonly y: number, readonly value: number }> = undefined
        const end = (commit: boolean): void => {
            if (!isDefined(drag)) {return}
            drag = undefined
            label.classList.remove("modifying")
            if (commit) {editing.mark()} else {editing.revertPending()}
        }
        lifecycle.ownAll(
            observe(update),
            Events.subscribe(label, "pointerdown", (event: PointerEvent) => {
                if (field.available?.() === false || event.button !== 0) {return}
                label.setPointerCapture(event.pointerId)
                label.classList.add("modifying")
                drag = {y: event.clientY, value: field.get()}
            }),
            Events.subscribe(label, "pointermove", (event: PointerEvent) => {
                if (!isDefined(drag)) {return}
                const steps = Math.round((drag.y - event.clientY) / PixelsPerStep)
                const next = clamp(drag.value + steps * field.step, field.min, field.max)
                if (next !== field.get()) {editing.modify(() => field.set(next), false)}
            }),
            Events.subscribe(label, "pointerup", () => end(true)),
            Events.subscribeDblDwn(label, async event => {
                if (field.available?.() === false) {return}
                end(false)
                const [text, unit] = field.print(field.get())
                const typed = await Surface.get(label).requestFloatingTextInput(event, unit.length > 0 ? `${text} ${unit}` : text)
                const value = field.parse(typed)
                if (isDefined(value) && Number.isFinite(value)) {
                    editing.modify(() => field.set(clamp(value, field.min, field.max)))
                }
            }),
            Events.subscribe(label, "pointercancel", () => end(false))
        )
        update()
        return label
    }
}
