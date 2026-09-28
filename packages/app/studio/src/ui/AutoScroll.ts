import {AABB, Client, Option, Padding, Provider, Terminable, Terminator} from "@opendaw/lib-std"
import {Surface} from "@/ui/surface/Surface.tsx"
import {AnimationFrame, Events} from "@opendaw/lib-dom"

export type AutoScroller = (deltaX: number, deltaY: number) => void

export type Options = {
    measure?: Provider<AABB>
    padding?: Padding
    dragPadding?: Padding // for a native drag entering the target, defaults to `padding`
}

const DragOverSilence = 1000

export const installAutoScroll = (target: Element, autoScroller: AutoScroller, options?: Options): Terminable => {
    const lifeTime = new Terminator()
    const measure: Provider<AABB> = options?.measure ?? (() => {
        const {bottom, left, right, top} = target.getBoundingClientRect()
        return {xMin: left, yMin: top, xMax: right, yMax: bottom}
    })
    const pointerPadding: Readonly<Padding> = options?.padding ?? Padding.Identity
    const dragPadding: Readonly<Padding> = options?.dragPadding ?? pointerPadding
    let scrolling: Option<Terminable> = Option.None
    let deltaX: number = 0.0
    let deltaY: number = 0.0
    let lastDragOver: number = 0.0
    let padding: Readonly<Padding> = pointerPadding
    const stop = () => {
        scrolling.ifSome(terminable => terminable.terminate())
        scrolling = Option.None
    }
    const moveListener = ({clientX, clientY}: Client) => {
        const {xMin, xMax, yMin, yMax} = AABB.padding(measure(), padding)
        deltaX = clientX < xMin ? clientX - xMin : clientX > xMax ? clientX - xMax : 0
        deltaY = clientY < yMin ? clientY - yMin : clientY > yMax ? clientY - yMax : 0
        const inside = deltaX === 0 && deltaY === 0
        if (scrolling.isEmpty()) {
            if (!inside) {
                scrolling = Option.wrap(AnimationFrame.add(() => {
                    // dragover keeps firing while a native drag stays in the window; silence means it left
                    if (lastDragOver > 0.0 && performance.now() - lastDragOver > DragOverSilence) {return stop()}
                    autoScroller(deltaX, deltaY)
                }))
            }
        } else {
            if (inside) {stop()}
        }
    }
    const dragOverListener = (event: DragEvent) => {
        lastDragOver = performance.now()
        moveListener(event)
    }
    const arm = (mode: "pointer" | "drag") => {
        const owner = Surface.get(target).owner.document
        lifeTime.terminate()
        lastDragOver = 0.0
        padding = mode === "drag" ? dragPadding : pointerPadding
        const upListener = () => {
            stop()
            lifeTime.terminate()
        }
        lifeTime.ownAll(
            Events.subscribe(owner, "dragover", dragOverListener, {capture: true}),
            Events.subscribe(owner, "pointermove", moveListener, {capture: true}),
            Events.subscribe(owner, "pointerup", upListener),
            Events.subscribe(owner, "dragend", upListener),
            Events.subscribe(owner, "drop", upListener, {capture: true})
        )
    }
    // A native drag from elsewhere (browser panel, OS files) never presses the pointer down on the target.
    return Terminable.many(
        Events.subscribe(target, "pointerdown", () => arm("pointer"), {capture: true}),
        Events.subscribe(target, "dragenter", () => {if (lifeTime.isEmpty()) {arm("drag")}}, {capture: true}),
        lifeTime
    )
}