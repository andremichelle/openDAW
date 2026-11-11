import {describe, expect, it, vi} from "vitest"
import {installArrangementTrackClick} from "./ArrangementTrackClick"

vi.mock("@opendaw/lib-dom", () => ({
    Events: {subscribe: (target: EventTarget, type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        target.addEventListener(type, listener, options)
        return {terminate: () => target.removeEventListener(type, listener, options)}
    }}
}))

const setup = () => {
    const owner = new EventTarget()
    const element = Object.assign(new EventTarget(), {ownerDocument: {defaultView: owner}}) as unknown as HTMLElement
    const select = vi.fn()
    const onPress = vi.fn((_: PointerEvent) => select)
    const subscription = installArrangementTrackClick(element, onPress)
    const pointer = (type: string, values = {}) => {
        const event = Object.assign(new Event(type), {
            pointerId: 1, isPrimary: true, button: 0, clientX: 140, clientY: 20, altKey: false, ...values
        })
        ;(type === "pointerdown" ? element : owner).dispatchEvent(event)
        return event
    }
    return {onPress, select, subscription, pointer}
}

describe("arrangement track clicks", () => {
    it.each(["shiftKey", "metaKey", "ctrlKey"])("selects on release with the original %s modifier", modifier => {
        const {onPress, select, subscription, pointer} = setup()
        const press = pointer("pointerdown", {[modifier]: true})
        expect(select).not.toHaveBeenCalled()
        pointer("pointerup", {pointerId: 2})
        expect(select).not.toHaveBeenCalled()
        pointer("pointerup")
        expect(onPress).toHaveBeenCalledExactlyOnceWith(press)
        expect(select).toHaveBeenCalledOnce()
        subscription.terminate()
    })

    it.each(["drag", "cancel", "alt"])("preserves selection after %s", gesture => {
        const {select, subscription, pointer} = setup()
        pointer("pointerdown", {altKey: gesture === "alt"})
        if (gesture === "drag") {pointer("pointermove", {clientX: 180})}
        if (gesture === "cancel") {pointer("pointercancel")}
        pointer("pointerup")
        expect(select).not.toHaveBeenCalled()
        subscription.terminate()
    })
})
