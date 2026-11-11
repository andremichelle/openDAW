import {Events} from "@opendaw/lib-dom"
import {Terminable, Terminator} from "@opendaw/lib-std"

// Observe clicks without taking pointer capture away from region edits or selection.
export const installArrangementTrackClick = (element: HTMLElement,
                                             onPress: (event: PointerEvent) => (() => void) | undefined): Terminable => {
    const gesture = new Terminator()
    const owner = element.ownerDocument.defaultView!
    return Terminable.many(gesture, Events.subscribe(element, "pointerdown", (down: PointerEvent) => {
        gesture.terminate()
        if (!down.isPrimary || down.button !== 0 || down.altKey) {return}
        const selectTrack = onPress(down)
        if (selectTrack === undefined) {return}
        const {pointerId, clientX, clientY} = down
        const moved = (event: PointerEvent) => Math.hypot(event.clientX - clientX, event.clientY - clientY) > 5
        gesture.ownAll(
            Events.subscribe(owner, "pointermove", (event: PointerEvent) => {
                if (event.pointerId === pointerId && moved(event)) {gesture.terminate()}
            }, {capture: true}),
            Events.subscribe(owner, "pointerup", (event: PointerEvent) => {
                if (event.pointerId !== pointerId) {return}
                gesture.terminate()
                if (moved(event) || event.altKey) {return}
                selectTrack()
            }, {capture: true}),
            Events.subscribe(owner, "pointercancel", (event: PointerEvent) => {
                if (event.pointerId === pointerId) {gesture.terminate()}
            }, {capture: true}),
            Events.subscribe(element, "lostpointercapture", (event: PointerEvent) => {
                if (event.pointerId === pointerId) {gesture.terminate()}
            }),
            Events.subscribe(owner, "keydown", (event: KeyboardEvent) => {
                if (event.key === "Escape") {gesture.terminate()}
            }, {capture: true}),
            Events.subscribe(owner, "blur", () => gesture.terminate())
        )
    }, {capture: true}))
}
