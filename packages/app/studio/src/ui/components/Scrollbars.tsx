import {isInstanceOf, Terminable, Terminator} from "@opendaw/lib-std"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {Orientation, Scroller} from "@/ui/components/Scroller"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"

const isScrollableOverflow = (value: string): boolean =>
    value === "auto" || value === "scroll" || value === "overlay"

export const bindNativeScroll = (element: HTMLElement, model: ScrollModel, orientation: Orientation): Terminable => {
    const vertical = orientation === Orientation.vertical
    const contentSize = () => vertical ? element.scrollHeight : element.scrollWidth
    let syncingFromNative = false
    const refresh = () => {
        syncingFromNative = true
        model.visibleSize = vertical ? element.clientHeight : element.clientWidth
        model.contentSize = contentSize()
        model.position = vertical ? element.scrollTop : element.scrollLeft
        syncingFromNative = false
    }
    refresh()
    let lastContentSize = contentSize()
    return Terminable.many(
        model.subscribe(() => {
            if (syncingFromNative) {return} // native scroll already moved the element; only thumb-drag writes back
            if (vertical) {element.scrollTop = model.position} else {element.scrollLeft = model.position}
        }),
        Events.subscribe(element, "scroll", refresh, {passive: true}),
        // Deferred for the same reason as in Scroller: reading and writing the model inside the observer
        // resizes the thumb within the same layout pass. Scroll events stay synchronous, they are not part
        // of that cycle.
        Html.watchResize(element, () => AnimationFrame.once(refresh)),
        AnimationFrame.add(() => {
            const size = contentSize()
            if (size !== lastContentSize) {
                lastContentSize = size
                refresh()
            }
        }))
}

type Options = { autoHide?: boolean }

export const installScrollbars = (element: HTMLElement, options?: Options): Terminable => {
    const autoHide = options?.autoHide ?? true
    const terminator = new Terminator()
    const mount = (layer: HTMLElement) => {
        const style = getComputedStyle(element)
        const overlay: HTMLElement = <div/>
        const {style: overlayStyle} = overlay
        overlayStyle.position = "absolute"
        overlayStyle.pointerEvents = "none"
        const orientations: Array<Orientation> = []
        if (isScrollableOverflow(style.overflowY)) {orientations.push(Orientation.vertical)}
        if (isScrollableOverflow(style.overflowX)) {orientations.push(Orientation.horizontal)}
        orientations.forEach(orientation => {
            const model = terminator.own(new ScrollModel())
            const bar: HTMLElement = <Scroller lifecycle={terminator} model={model} orientation={orientation} floating
                                               autoHide={autoHide}/>
            bar.style.pointerEvents = "auto"
            overlay.appendChild(bar)
            terminator.own(bindNativeScroll(element, model, orientation))
        })
        layer.appendChild(overlay)
        const reposition = () => {
            const {offsetLeft, offsetTop, clientWidth, clientHeight} = element
            const {paddingTop, paddingBottom} = getComputedStyle(element)
            const top = parseFloat(paddingTop)
            const bottom = parseFloat(paddingBottom)
            overlayStyle.left = `${offsetLeft}px`
            overlayStyle.top = `${offsetTop + top}px`
            overlayStyle.width = `${clientWidth}px`
            overlayStyle.height = `${clientHeight - top - bottom}px`
        }
        reposition()
        const scheduleReposition = () => AnimationFrame.once(reposition)
        terminator.ownAll(
            Html.watchResize(element, scheduleReposition),
            Html.watchResize(layer, scheduleReposition),
            {terminate: () => overlay.remove()})
    }
    // The host may be hidden (display: none) at connect time — e.g. overlays/dialogs — so it has no
    // offsetParent yet. Defer mounting until it becomes visible (watchResize fires when it gets a size).
    let mounted = false
    const tryMount = () => {
        if (mounted) {return}
        const layer = element.offsetParent
        if (!isInstanceOf(layer, HTMLElement)) {return}
        mounted = true
        mount(layer)
    }
    terminator.own(Html.watchResize(element, tryMount))
    tryMount()
    return terminator
}
