import {clamp, Editing, Func, int, isDefined, Lifecycle, Option, Optional, Procedure, Provider, Subscription} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {FloatingTextInput} from "@/ui/components/FloatingTextInput"
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
    const DeadZone = 3

    // a typed text, or none when the input was left or cancelled
    export const ask = async (element: HTMLElement, {clientX, clientY}: MouseEvent, shown: string): Promise<Option<string>> => {
        const resolvers = Promise.withResolvers<string>()
        Surface.get(element).flyout.appendChild(FloatingTextInput({position: {x: clientX, y: clientY}, value: shown, resolvers}))
        const {status, value} = await Promises.tryCatch(resolvers.promise)
        return status === "resolved" ? Option.wrap(value) : Option.None
    }

    export type Choice = {
        readonly names: ReadonlyArray<string>
        readonly get: Provider<int>
        readonly set: Procedure<int>
        readonly available?: Provider<boolean>
    }

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

    export type Subject = {
        readonly element: HTMLElement
        readonly min: number
        readonly max: number
        readonly step: number
        readonly get: Provider<number>
        readonly set: Procedure<number>
    }
    export type Gesture = {
        readonly begin: (subject: Subject, event: PointerEvent) => void
        readonly move: Procedure<PointerEvent>
        // returns the subject that was pressed without being dragged, a click
        readonly end: Func<boolean, Option<Subject>>
    }

    export const gesture = (editing: Editing): Gesture => {
        let active: Optional<{ readonly subject: Subject, y: number, readonly value: number, moved: boolean }> = undefined
        return {
            begin: (subject, event) => {
                subject.element.classList.add("modifying")
                active = {subject, y: event.clientY, value: subject.get(), moved: false}
            },
            move: event => {
                if (!isDefined(active)) {return}
                const {subject, value} = active
                if (!active.moved) {
                    const slipped = active.y - event.clientY
                    if (Math.abs(slipped) < DeadZone) {return}
                    active.y -= Math.sign(slipped) * DeadZone
                    active.moved = true
                }
                const steps = Math.round((active.y - event.clientY) / PixelsPerStep)
                const next = clamp(value + steps * subject.step, subject.min, subject.max)
                if (next === subject.get()) {return}
                editing.modify(() => subject.set(next), false)
            },
            end: commit => {
                if (!isDefined(active)) {return Option.None}
                const {subject, moved} = active
                active = undefined
                subject.element.classList.remove("modifying")
                if (!moved) {return commit ? Option.wrap(subject) : Option.None}
                if (commit) {editing.mark()} else {editing.revertPending()}
                return Option.None
            }
        }
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
        const subject: Subject = {element: label, min: field.min, max: field.max, step: field.step, get: field.get, set: field.set}
        const drag = gesture(editing)
        lifecycle.ownAll(
            observe(update),
            Events.subscribe(label, "pointerdown", (event: PointerEvent) => {
                if (field.available?.() === false || event.button !== 0) {return}
                label.setPointerCapture(event.pointerId)
                drag.begin(subject, event)
            }),
            Events.subscribe(label, "pointermove", drag.move),
            Events.subscribe(label, "pointerup", () => drag.end(true)),
            Events.subscribeDblDwn(label, async event => {
                if (field.available?.() === false) {return}
                drag.end(false)
                const [text, unit] = field.print(field.get())
                const typed = await ask(label, event, unit.length > 0 ? `${text} ${unit}` : text)
                if (typed.isEmpty()) {return}
                const value = field.parse(typed.unwrap())
                if (isDefined(value) && Number.isFinite(value)) {
                    editing.modify(() => field.set(clamp(value, field.min, field.max)))
                }
            }),
            Events.subscribe(label, "pointercancel", () => drag.end(false))
        )
        update()
        return label
    }
}
