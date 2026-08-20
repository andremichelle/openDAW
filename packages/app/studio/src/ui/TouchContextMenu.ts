import {isNull, Nullable, Terminable, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"

// WebKit never dispatches 'contextmenu' for a long-press on generic elements, so we synthesise it.
export namespace TouchContextMenu {
    export const DURATION = 500
    export const SLOP = 10

    export const install = (owner: WindowProxy): Terminable => {
        const terminator = new Terminator()
        let timeoutId: Nullable<ReturnType<typeof setTimeout>> = null
        let suppressCompat = false
        let originX = 0
        let originY = 0
        const cancel = () => {
            if (isNull(timeoutId)) {return}
            clearTimeout(timeoutId)
            timeoutId = null
        }
        const fire = (target: EventTarget) => {
            timeoutId = null
            suppressCompat = true
            target.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true, cancelable: true, composed: true,
                clientX: originX, clientY: originY, button: 2, buttons: 2
            }))
        }
        // The compat mouse events arrive when the finger lifts, and their focus move would blur the menu away.
        const suppress = (event: MouseEvent) => {
            if (!suppressCompat) {return}
            event.preventDefault()
            event.stopImmediatePropagation()
        }
        terminator.ownAll(
            Events.subscribe(owner, "pointerdown", (event: PointerEvent) => {
                cancel()
                suppressCompat = false
                if (event.pointerType !== "touch" || isNull(event.target) || Events.isTextInput(event.target)) {return}
                const target = event.target
                originX = event.clientX
                originY = event.clientY
                timeoutId = setTimeout(() => fire(target), DURATION)
            }, {capture: true}),
            Events.subscribe(owner, "pointermove", (event: PointerEvent) => {
                if (isNull(timeoutId)) {return}
                if (Math.abs(event.clientX - originX) > SLOP || Math.abs(event.clientY - originY) > SLOP) {cancel()}
            }, {capture: true}),
            Events.subscribe(owner, "pointerup", cancel, {capture: true}),
            Events.subscribe(owner, "pointercancel", cancel, {capture: true}),
            Events.subscribe(owner, "mousedown", suppress, {capture: true}),
            Events.subscribe(owner, "mouseup", suppress, {capture: true}),
            Events.subscribe(owner, "click", (event: MouseEvent) => {
                suppress(event)
                suppressCompat = false
            }, {capture: true})
        )
        return terminator
    }
}
