import {int, isDefined, Maybe, Nullable, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {CssUtils, Events} from "@opendaw/lib-dom"
import {ElementCapturing} from "@opendaw/studio-core"

export type CursorEvent = {
    clientX: number
    clientY: number
    altKey: boolean
    shiftKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    buttons: int
    type: string
}

export type CursorProvider<TYPE> = {
    get: (capture: TYPE, event: CursorEvent) => Maybe<CssUtils.Cursor | number>
    leave?: () => void // cleanup, if you synchronized someting to certain cursors
}

export const installCursor = <TARGET>(element: Element,
                                      capturing: ElementCapturing<TARGET>,
                                      provider: CursorProvider<Nullable<TARGET>>): Terminable => {
    let clientX: number = 0.0
    let clientY: number = 0.0
    let buttons: int = 0
    let captured: boolean = false
    let keyboardSubscription: Subscription = Terminable.Empty

    const lifecycle = new Terminator()
    const changeCursor = (event: CursorEvent) => {
        const identifier = provider.get(capturing.captureEvent(event), event) ?? "auto"
        Surface.forEach(surface => CssUtils.setCursor(identifier, surface.owner.document))
    }
    const keyboardListener = (event: KeyboardEvent) => {
        if (!event.repeat && !captured) {
            changeCursor({
                clientX,
                clientY,
                buttons,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                type: event.type
            })
        }
    }
    lifecycle.own(Events.subscribe(element, "pointerenter", () => {
        const eventTarget = Surface.get(element).owner
        keyboardSubscription.terminate()
        keyboardSubscription = Terminable.many(
            Events.subscribe(eventTarget, "keydown", keyboardListener), Events.subscribe(eventTarget, "keyup", keyboardListener)
        )
    }))
    lifecycle.own(Events.subscribe(element, "pointermove", (event: PointerEvent) => {
        clientX = event.clientX
        clientY = event.clientY
        buttons = event.buttons
        if (event.buttons === 0) {
            changeCursor(event)
        }
    }))
    lifecycle.own(Events.subscribe(element, "gotpointercapture", () => captured = true))
    lifecycle.own(Events.subscribe(element, "lostpointercapture", (event: PointerEvent) => {
        captured = false
        changeCursor(event)
    }))
    lifecycle.own(Events.subscribe(element, "pointerup", (event: PointerEvent) => changeCursor(event)))
    lifecycle.own(Events.subscribe(element, "pointerleave", (event: PointerEvent) => {
        if (event.buttons > 0) {return}
        keyboardSubscription.terminate()
        if (isDefined(provider.leave)) {
            provider.leave()
        }
        CssUtils.setCursor("auto")
    }))
    lifecycle.own({terminate: () => keyboardSubscription.terminate()})
    return lifecycle
}