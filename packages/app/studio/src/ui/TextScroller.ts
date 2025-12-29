import {clamp, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events} from "@opendaw/lib-dom"

export namespace TextScroller {
    export const install = (element: HTMLElement): Terminable => {
        element.style.overflow = "hidden"
        const scrolling = new Terminator()
        return Terminable.many(
            Events.subscribe(element, "pointerenter", () => {
                element.style.textOverflow = "clip"
                let x = 0.0
                scrolling.own(AnimationFrame.add(() => {
                    const smoothStep = (k: number) => k * k * (3.0 - 2.0 * k)
                    const t = 1.0 - Math.abs(2.0 * (Math.floor(x) - x) + 1.0)
                    const moveFunc = smoothStep(clamp((t - 0.25) / (0.75 - 0.25), 0.0, 1.0))
                    element.scrollTop = moveFunc * (element.scrollHeight - element.clientHeight)
                    element.scrollLeft = moveFunc * (element.scrollWidth - element.clientWidth)
                    x += 0.125 / Math.max(element.scrollWidth, element.scrollHeight)
                }))
            }),
            Events.subscribe(element, "pointerleave", () => {
                element.style.textOverflow = "ellipsis"
                element.scrollLeft = 0
                scrolling.terminate()
            }),
            scrolling
        )
    }
}