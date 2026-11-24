import {isAbsent, isDefined, Nullable, Procedure, Subscription} from "@opendaw/lib-std"

type KnownEventMap = WindowEventMap & MIDIInputEventMap & MIDIPortEventMap

export class Events {
    static subscribe<K extends keyof KnownEventMap>(eventTarget: EventTarget,
                                                    type: K,
                                                    listener: (ev: KnownEventMap[K]) => void,
                                                    options?: boolean | AddEventListenerOptions): Subscription {
        eventTarget.addEventListener(type, listener as EventListener, options)
        return {terminate: () => eventTarget.removeEventListener(type, listener as EventListener, options)}
    }

    static subscribeAny<E extends Event>(eventTarget: EventTarget,
                                         type: string,
                                         listener: (event: E) => void,
                                         options?: boolean | AddEventListenerOptions): Subscription {
        eventTarget.addEventListener(type, listener as EventListener, options)
        return {terminate: (): void => eventTarget.removeEventListener(type, listener as EventListener, options)}
    }

    static DOUBLE_DOWN_THRESHOLD = 200 as const
    static DOUBLE_DOWN_DISTANCE = 4 as const
    static DOUBLE_TAP_DISTANCE = 24 as const

    static subscribeDblDwn = (eventTarget: EventTarget, listener: Procedure<PointerEvent>): Subscription =>
        this.#subscribeDouble(eventTarget, "pointerdown", listener)

    static subscribeDblUp = (eventTarget: EventTarget, listener: Procedure<PointerEvent>): Subscription =>
        this.#subscribeDouble(eventTarget, "pointerup", listener)

    // two presses count as double only when they are quick AND land on the same spot
    static #subscribeDouble = (eventTarget: EventTarget,
                               type: "pointerdown" | "pointerup",
                               listener: Procedure<PointerEvent>): Subscription => {
        const last = {time: Number.NEGATIVE_INFINITY, x: 0.0, y: 0.0}
        return this.subscribe(eventTarget, type, event => {
            const now = performance.now()
            const distance = event.pointerType === "mouse" ? this.DOUBLE_DOWN_DISTANCE : this.DOUBLE_TAP_DISTANCE
            if (now - last.time < this.DOUBLE_DOWN_THRESHOLD
                && Math.hypot(event.clientX - last.x, event.clientY - last.y) <= distance) {
                event.preventDefault()
                event.stopImmediatePropagation()
                listener(event)
                last.time = Number.NEGATIVE_INFINITY
                return
            }
            last.time = now
            last.x = event.clientX
            last.y = event.clientY
        }, {capture: true})
    }

    // ignores the second click of a double click (event.detail counts the clicks of the sequence)
    static subscribeSingleClick(eventTarget: EventTarget, listener: (event: MouseEvent) => void): Subscription {
        return this.subscribe(eventTarget, "click", event => {if (event.detail <= 1) {listener(event)}})
    }

    static readonly PreventDefault: Procedure<Event> = event => event.preventDefault()

    static readonly isTextInput = (target: Nullable<EventTarget>): boolean => {
        return target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || (target instanceof HTMLElement && isDefined(target.getAttribute("contenteditable")))
    }

    /**
     * Detects keyboard events triggered by browser autofill (e.g., Safari).
     * Autofill events often have empty or missing key/code properties.
     */
    static isAutofillEvent(event: KeyboardEvent): boolean {
        return isAbsent(event.key) || event.key === ""
            || event.key === "Unidentified" || isAbsent(event.code) || event.code === ""
    }
}

export interface PointerCaptureTarget extends EventTarget {
    setPointerCapture(pointerId: number): void
    releasePointerCapture(pointerId: number): void
    hasPointerCapture(pointerId: number): boolean
}