import {isInstanceOf, panic, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Orientation, Scroller} from "@/ui/components/Scroller"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"

const isScrollableOverflow = (value: string): boolean =>
    value === "auto" || value === "scroll" || value === "overlay"

export const bindNativeScroll = (element: HTMLElement, model: ScrollModel, orientation: Orientation): Terminable => {
    const vertical = orientation === Orientation.vertical
    const contentSize = () => vertical ? element.scrollHeight : element.scrollWidth
    const refresh = () => {
        model.visibleSize = vertical ? element.clientHeight : element.clientWidth
        model.contentSize = contentSize()
        model.position = vertical ? element.scrollTop : element.scrollLeft
    }
    refresh()
    let lastContentSize = contentSize()
    return Terminable.many(
        model.subscribe(() => {
            if (vertical) {element.scrollTop = model.position} else {element.scrollLeft = model.position}
        }),
        Events.subscribe(element, "scroll", refresh, {passive: true}),
        Html.watchResize(element, refresh),
        AnimationFrame.add(() => {
            const size = contentSize()
            if (size !== lastContentSize) {
                lastContentSize = size
                refresh()
            }
        }))
}

export const installScrollbars = (element: HTMLElement): Terminable => {
    const layer = element.offsetParent
    if (!isInstanceOf(layer, HTMLElement)) {
        return panic("installScrollbars: host has no offsetParent to mount the scrollbars onto")
    }
    const style = getComputedStyle(element)
    const terminator = new Terminator()
    const overlay: HTMLElement = <div/>
    const {style: overlayStyle} = overlay
    overlayStyle.position = "absolute"
    overlayStyle.pointerEvents = "none"
    const orientations: Array<Orientation> = []
    if (isScrollableOverflow(style.overflowY)) {orientations.push(Orientation.vertical)}
    if (isScrollableOverflow(style.overflowX)) {orientations.push(Orientation.horizontal)}
    orientations.forEach(orientation => {
        const model = terminator.own(new ScrollModel())
        const bar: HTMLElement = <Scroller lifecycle={terminator} model={model} orientation={orientation} floating/>
        bar.style.pointerEvents = "auto"
        overlay.appendChild(bar)
        terminator.own(bindNativeScroll(element, model, orientation))
    })
    layer.appendChild(overlay)
    const reposition = () => {
        const {offsetLeft, offsetTop, clientWidth, clientHeight} = element
        overlayStyle.left = `${offsetLeft}px`
        overlayStyle.top = `${offsetTop}px`
        overlayStyle.width = `${clientWidth}px`
        overlayStyle.height = `${clientHeight}px`
    }
    reposition()
    terminator.ownAll(
        Html.watchResize(element, reposition),
        Html.watchResize(layer, reposition),
        {terminate: () => overlay.remove()})
    return terminator
}
