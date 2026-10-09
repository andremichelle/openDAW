import css from "./FloatingWindow.sass?inline"
import {
    clamp, DefaultObservableValue, Exec, Func, int, isDefined, isNull, MutableObservableOption, Nullable, ObservableValue, Option, Point,
    safeExecute, Size, Terminator, UUID
} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {Button} from "@/ui/components/Button.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {MenuButton} from "@/ui/components/MenuButton.tsx"
import {MenuItem} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "FloatingWindow")

type Construct = {
    title: string
    icon?: IconSymbol
    width: int
    height: int
    position?: Point
    scale?: number
    resizable?: boolean
    // fixed zoom steps (1 = width x height) replace the resize grips
    zoomLevels?: ReadonlyArray<number>
    minWidth?: int
    minHeight?: int
    adjust?: Func<Size, Promise<Size>>
    popoutable?: boolean
    onClose?: Exec
}

export interface FloatingWindowHandle {
    readonly size: ObservableValue<Size>
    // the browser window the content lives in, listeners bound to a window must follow it
    readonly owner: ObservableValue<Window>
    togglePopout(): void
    resetSize(): void
    // the content asks for a size (a plugin zooming its editor): taken as is, the body scrolls what does not fit
    requestSize(width: int, height: int): void
    // scrolls the body when the content is larger than the space on screen (wheel events the content did not use)
    scrollBy(deltaX: number, deltaY: number): void
    toFront(): void
    close(): void
}

type ResizeAxis = { x: boolean, y: boolean }
type Adjusting = { busy: boolean, closed: boolean, next: Nullable<Size> }

// FloatingWindow.sass: div.body.scrolling scrollbars
const SCROLLBAR = 8
// the share of a window that always stays inside the browser
const VISIBLE_SHARE = 0.1

// z-order by index, never by moving the element (that reloads an embedded iframe)
const stack: Array<HTMLElement> = []
// below the tour ring (9998), above the chat overlay (5000)
const STACK_BASE = 9000
const restack = () => stack.forEach((entry, index) => {
    entry.style.zIndex = `${STACK_BASE + index}`
    entry.classList.toggle("inactive", index < stack.length - 1)
})

export const FloatingWindow = ({
                                   title, icon, width, height, position, scale, resizable, zoomLevels, minWidth, minHeight, adjust,
                                   popoutable, onClose
                               }: Construct, children: JsxValue): FloatingWindowHandle => {
    const lifecycle = new Terminator()
    const surface = Surface.get()
    const zoomable = isDefined(zoomLevels) && zoomLevels.length > 0
    const minimum: Size = {width: minWidth ?? 120, height: minHeight ?? 80}
    const adjusting: Adjusting = {busy: false, closed: false, next: null}
    const initialScale = scale ?? 1
    const fitScale = Math.max(Math.min(initialScale, (window.innerWidth - 32) / width, (window.innerHeight - 64) / height),
        minimum.width / width, minimum.height / height)
    // the content's size; the body shows as much of it as fits on screen and scrolls the rest (see layout)
    const contentWidth = Math.max(minimum.width, Math.round(width * (zoomable ? fitScale : initialScale)))
    const contentHeight = Math.max(minimum.height, Math.round(height * (zoomable ? fitScale : initialScale)))
    const bodyWidth = Math.min(contentWidth, window.innerWidth - 32)
    const bodyHeight = Math.min(contentHeight, window.innerHeight - 64)
    const size = lifecycle.own(new DefaultObservableValue<Size>({width: contentWidth, height: contentHeight}))
    const zoom = lifecycle.own(new DefaultObservableValue<number>(fitScale))
    const owner = lifecycle.own(new DefaultObservableValue<Window>(window))
    const popout = new MutableObservableOption<Surface>()
    const origin = isDefined(position)
        ? {x: position.x, y: position.y}
        : {x: (window.innerWidth - bodyWidth) * 0.5, y: (window.innerHeight - bodyHeight) * 0.5}
    const zoomLabel: HTMLElement = <span className="zoom"/>
    const header: HTMLElement = (
        <header>
            {isDefined(icon) && <Icon symbol={icon}/>}
            <span>{title}</span>
            {zoomable && (
                <MenuButton root={MenuItem.root().setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...(zoomLevels ?? []).map(level => MenuItem.default({
                        label: `${Math.round(level * 100)}%`,
                        checked: Math.abs(zoom.getValue() - level) < 1e-3
                    }).setTriggerProcedure(() => setZoom(level)))))}
                            appearance={{color: Colors.shadow, tinyTriangle: true, tooltip: "Zoom"}}>
                    {zoomLabel}
                </MenuButton>
            )}
            {popoutable !== false && (
                <Button lifecycle={lifecycle} onClick={() => togglePopout()}
                        appearance={{color: Colors.shadow, tooltip: () => popout.nonEmpty() ? "Back into the studio" : "Popout into new browser window"}}>
                    <Icon symbol={IconSymbol.Popout}/>
                </Button>
            )}
            {resizable !== false && (
                <Button lifecycle={lifecycle} onClick={() => resetSize()}
                        appearance={{color: Colors.shadow, tooltip: "Default size"}}>
                    <Icon symbol={IconSymbol.ZoomFit}/>
                </Button>
            )}
            <Button lifecycle={lifecycle} onClick={() => close()} appearance={{color: Colors.shadow, tooltip: "Close"}}>
                <Icon symbol={IconSymbol.Close}/>
            </Button>
        </header>
    )
    const body: HTMLElement = <div className="body">{children}<div className="shield"/></div>
    const grips: ReadonlyArray<[HTMLElement, ResizeAxis]> = resizable === false ? [] : [
        [<div className="grip right"/>, {x: true, y: false}],
        [<div className="grip bottom"/>, {x: false, y: true}],
        [<div className="grip corner"/>, {x: true, y: true}]
    ]
    const element: HTMLElement = (
        <div className={className}>
            {header}
            {body}
            {grips.map(([grip]) => grip)}
        </div>
    )
    Layers.install(element)
    // the window may hang out of the browser, but keeps VISIBLE_SHARE of it inside (on the right and bottom at
    // least its header), so it can always be dragged back. The top stays inside: the header is the handle.
    const move = (x: number, y: number) => {
        if (popout.nonEmpty()) {return}
        const {offsetWidth, offsetHeight} = element
        const visibleWidth = Math.min(offsetWidth, Math.max(header.offsetHeight, offsetWidth * VISIBLE_SHARE))
        const visibleHeight = Math.min(offsetHeight, Math.max(header.offsetHeight, offsetHeight * VISIBLE_SHARE))
        origin.x = clamp(x, visibleWidth - offsetWidth, Math.max(0, window.innerWidth - visibleWidth))
        origin.y = clamp(y, 0, Math.max(0, window.innerHeight - visibleHeight))
        element.style.left = `${origin.x}px`
        element.style.top = `${origin.y}px`
        layout()
    }
    const limits = (): Size => popout.match({
        // the browser window, not the space right of and below the window: moving it out does not shrink it
        none: () => ({
            width: Math.max(minimum.width, window.innerWidth),
            height: Math.max(minimum.height, window.innerHeight - header.offsetHeight)
        }),
        some: ({owner}) => ({
            width: Math.max(minimum.width, owner.innerWidth),
            height: Math.max(minimum.height, owner.innerHeight - header.offsetHeight)
        })
    })
    // the popout header has no bottom margin, so header and body fill the browser window exactly
    const resizeWindow = (width: number, height: number) => popout.ifSome(({owner}) =>
        owner.resizeBy(width - owner.innerWidth, height + header.offsetHeight - owner.innerHeight))
    const resize = (width: number, height: number) => {
        const {width: maxWidth, height: maxHeight} = limits()
        request({
            width: Math.round(clamp(width, minimum.width, maxWidth)),
            height: Math.round(clamp(height, minimum.height, maxHeight))
        })
    }
    const request = (next: Size) => {
        if (!isDefined(adjust)) {return apply(next)}
        adjusting.next = next
        negotiate()
    }
    // the body takes the content's size up to the space left on screen, larger content scrolls in it with a
    // scrollbar on each axis that does not fit (FloatingWindow.sass draws them always, SCROLLBAR wide)
    const layout = () => {
        const {width: contentWidth, height: contentHeight} = size.getValue()
        const {width: maxWidth, height: maxHeight} = limits()
        let scrollX = contentWidth > maxWidth
        let scrollY = contentHeight > maxHeight
        // a bar takes room from the other axis, which may then not fit either
        scrollX ||= scrollY && contentWidth + SCROLLBAR > maxWidth
        scrollY ||= scrollX && contentHeight + SCROLLBAR > maxHeight
        const visibleWidth = Math.min(contentWidth + (scrollY ? SCROLLBAR : 0), maxWidth)
        const visibleHeight = Math.min(contentHeight + (scrollX ? SCROLLBAR : 0), maxHeight)
        body.style.width = `${visibleWidth}px`
        body.style.height = `${visibleHeight}px`
        body.style.overflowX = scrollX ? "scroll" : "hidden"
        body.style.overflowY = scrollY ? "scroll" : "hidden"
        body.style.setProperty("--content-width", `${contentWidth}px`)
        body.style.setProperty("--content-height", `${contentHeight}px`)
        body.classList.toggle("scrolling", scrollX || scrollY)
    }
    const apply = (next: Size) => {
        const current = size.getValue()
        if (current.width === next.width && current.height === next.height) {return}
        size.setValue(next)
        layout()
        if (zoomable) {resizeWindow(next.width, next.height)}
    }
    const negotiate = () => {
        if (!isDefined(adjust) || adjusting.busy || adjusting.closed || isNull(adjusting.next)) {return}
        const requested = adjusting.next
        adjusting.next = null
        adjusting.busy = true
        adjust(requested).then(accepted => {
            adjusting.busy = false
            if (adjusting.closed) {return}
            apply(accepted)
            move(origin.x, origin.y)
            negotiate()
        }, () => adjusting.busy = false)
    }
    const setZoom = (level: number) => {
        zoom.setValue(level)
        request({width: Math.round(width * level), height: Math.round(height * level)})
    }
    const resetSize = () => {
        const target: Size = {width: Math.round(width * initialScale), height: Math.round(height * initialScale)}
        if (popout.nonEmpty()) {
            resizeWindow(target.width, target.height)
            return
        }
        // a new size moves the window into view as far as it fits, from the top left
        move(Math.max(0, Math.min(origin.x, window.innerWidth - target.width)),
            Math.max(0, Math.min(origin.y, window.innerHeight - target.height - header.offsetHeight)))
        resize(target.width, target.height)
    }
    const requestSize = (requestedWidth: int, requestedHeight: int) => {
        zoom.setValue(requestedWidth / width)
        if (popout.nonEmpty()) {
            apply({width: Math.max(minimum.width, Math.round(requestedWidth)), height: Math.max(minimum.height, Math.round(requestedHeight))})
            return
        }
        // a new size moves the window into view as far as it fits, from the top left
        move(Math.max(0, Math.min(origin.x, window.innerWidth - requestedWidth)),
            Math.max(0, Math.min(origin.y, window.innerHeight - requestedHeight - header.offsetHeight)))
        apply({width: Math.max(minimum.width, Math.round(requestedWidth)), height: Math.max(minimum.height, Math.round(requestedHeight))})
    }
    const scrollBy = (deltaX: number, deltaY: number) => body.scrollBy(deltaX, deltaY)
    const toFront = () => {
        if (popout.nonEmpty() || stack.at(-1) === element) {return}
        const index = stack.indexOf(element)
        if (index !== -1) {stack.splice(index, 1)}
        stack.push(element)
        restack()
    }
    const removeFromStack = () => {
        const index = stack.indexOf(element)
        if (index !== -1) {stack.splice(index, 1)}
        restack()
    }
    const popOut = () => {
        const {width, height} = size.getValue()
        const {left, top} = element.getBoundingClientRect()
        const position: Point = {x: window.screenX + left, y: window.screenY + window.outerHeight - window.innerHeight + top}
        surface.new(width, height + header.offsetHeight, UUID.toString(UUID.generate()), title, position).match({
            none: () => {Dialogs.info({message: "Could not open window. Check popup blocker?"}).finally()},
            some: popped => {
                popout.wrap(popped)
                removeFromStack()
                element.classList.remove("inactive")
                element.classList.add("popout")
                element.style.removeProperty("left")
                element.style.removeProperty("top")
                popped.ground.appendChild(element)
                owner.setValue(popped.owner)
                popped.own({terminate: () => {if (popout.contains(popped)) {dockIn()}}})
                // the popout window may come out smaller than asked (screen size): the body scrolls in what it got
                popped.own(Events.subscribe(popped.owner, "resize", () => {
                    if (resizable !== false) {
                        resize(popped.owner.innerWidth, popped.owner.innerHeight - header.offsetHeight)
                    }
                    layout()
                }))
                layout()
            }
        })
    }
    const dockIn = () => popout.ifSome(popped => {
        popout.clear()
        element.classList.remove("popout")
        surface.floating.appendChild(element)
        owner.setValue(window)
        toFront()
        move(origin.x, origin.y)
        if (resizable !== false) {
            const {width, height} = size.getValue()
            resize(width, height)
        }
        popped.close()
    })
    const togglePopout = () => popout.nonEmpty() ? dockIn() : popOut()
    const close = () => {
        adjusting.closed = true
        removeFromStack()
        popout.ifSome(popped => {
            popout.clear()
            popped.close()
        })
        lifecycle.terminate()
        element.remove()
        safeExecute(onClose)
    }
    lifecycle.own(Dragging.attach(header, (beginEvent: PointerEvent) => {
        if (popout.nonEmpty()) {return Option.None}
        if (beginEvent.target instanceof Element && beginEvent.target.closest("[data-class='button']") !== null) {return Option.None}
        const startX = origin.x - beginEvent.clientX
        const startY = origin.y - beginEvent.clientY
        return Option.wrap({update: (event: Dragging.Event) => move(startX + event.clientX, startY + event.clientY)})
    }))
    grips.forEach(([grip, axis]) => lifecycle.own(Dragging.attach(grip, (beginEvent: PointerEvent) => {
        const {width: startWidth, height: startHeight} = size.getValue()
        return Option.wrap({
            update: (event: Dragging.Event) => resize(
                axis.x ? startWidth + event.clientX - beginEvent.clientX : startWidth,
                axis.y ? startHeight + event.clientY - beginEvent.clientY : startHeight)
        })
    })))
    lifecycle.own(zoom.catchupAndSubscribe(owner => zoomLabel.textContent = `${Math.round(owner.getValue() * 100)}%`))
    lifecycle.own(Events.subscribe(element, "pointerdown", toFront, {capture: true}))
    lifecycle.own(Events.subscribe(element, "focusin", toFront))
    lifecycle.own(Events.subscribe(window, "resize", () => move(origin.x, origin.y)))
    body.style.width = `${bodyWidth}px`
    body.style.height = `${bodyHeight}px`
    surface.floating.appendChild(element)
    toFront()
    move(origin.x, origin.y)
    if (isDefined(adjust)) {request(size.getValue())}
    return {size, owner, togglePopout, resetSize, requestSize, scrollBy, toFront, close}
}
