import {AABB, Client, Option, Padding, Provider, Terminable, Terminator} from "@moises-ai/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {AnimationFrame, Events} from "@moises-ai/lib-dom"

export type AutoScroller = (deltaX: number, deltaY: number) => void

export type Options = {
    measure?: Provider<AABB>
    padding?: Padding
}

export const installAutoScroll = (target: Element, autoScroller: AutoScroller, options?: Options): Terminable => {
    const lifeTime = new Terminator()
    const measure: Provider<AABB> = options?.measure ?? (() => {
        const {bottom, left, right, top} = target.getBoundingClientRect()
        return {xMin: left, yMin: top, xMax: right, yMax: bottom}
    })
    const padding: Readonly<Padding> = options?.padding ?? Padding.Identity
    let scrolling: Option<Terminable> = Option.None
    let deltaX: number = 0.0
    let deltaY: number = 0.0
    const moveListener = ({clientX, clientY}: Client) => {
        const {xMin, xMax, yMin, yMax} = AABB.padding(measure(), padding)
        deltaX = clientX < xMin ? clientX - xMin : clientX > xMax ? clientX - xMax : 0
        deltaY = clientY < yMin ? clientY - yMin : clientY > yMax ? clientY - yMax : 0
        const inside = deltaX === 0 && deltaY === 0
        if (scrolling.isEmpty()) {
            if (!inside) {
                scrolling = Option.wrap(AnimationFrame.add(() => autoScroller(deltaX, deltaY)))
            }
        } else {
            if (inside) {
                scrolling.unwrap().terminate()
                scrolling = Option.None
            }
        }
    }
    return Events.subscribe(target, "pointerdown", () => {
        const owner = Surface.get(target).owner.document
        lifeTime.terminate()
        const upListener = () => {
            scrolling.ifSome(terminable => terminable.terminate())
            scrolling = Option.None
            lifeTime.terminate()
        }
        lifeTime.ownAll(
            Events.subscribe(owner, "dragover", moveListener, {capture: true}),
            Events.subscribe(owner, "pointermove", moveListener, {capture: true}),
            Events.subscribe(owner, "pointerup", upListener),
            Events.subscribe(owner, "dragend", upListener)
        )
    }, {capture: true})
}