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
    // the content asks for a size (a plugin zooming its editor): taken as is, only kept on screen
    requestSize(width: int, height: int): void
    toFront(): void
    close(): void
}

type ResizeAxis = { x: boolean, y: boolean }
type Adjusting = { busy: boolean, closed: boolean, next: Nullable<Size> }

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
    const bodyWidth = zoomable ? Math.round(width * fitScale)
        : Math.max(minimum.width, Math.min(Math.round(width * initialScale), window.innerWidth - 32))
    const bodyHeight = zoomable ? Math.round(height * fitScale)
        : Math.max(minimum.height, Math.min(Math.round(height * initialScale), window.innerHeight - 64))
    const size = lifecycle.own(new DefaultObservableValue<Size>({width: bodyWidth, height: bodyHeight}))
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
    const move = (x: number, y: number) => {
        if (popout.nonEmpty()) {return}
        origin.x = clamp(x, 0, Math.max(0, window.innerWidth - element.offsetWidth))
        origin.y = clamp(y, 0, Math.max(0, window.innerHeight - header.offsetHeight))
        element.style.left = `${origin.x}px`
        element.style.top = `${origin.y}px`
    }
    const limits = (): Size => popout.match({
        none: () => ({
            width: Math.max(minimum.width, window.innerWidth - origin.x),
            height: Math.max(minimum.height, window.innerHeight - origin.y - header.offsetHeight)
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
    const apply = (next: Size) => {
        const current = size.getValue()
        if (current.width === next.width && current.height === next.height) {return}
        body.style.width = `${next.width}px`
        body.style.height = `${next.height}px`
        size.setValue(next)
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
        move(Math.min(origin.x, window.innerWidth - target.width),
            Math.min(origin.y, window.innerHeight - target.height - header.offsetHeight))
        resize(target.width, target.height)
    }
    const requestSize = (requestedWidth: int, requestedHeight: int) => {
        zoom.setValue(requestedWidth / width)
        if (popout.nonEmpty()) {
            apply({width: Math.max(minimum.width, Math.round(requestedWidth)), height: Math.max(minimum.height, Math.round(requestedHeight))})
            return
        }
        move(Math.min(origin.x, window.innerWidth - requestedWidth),
            Math.min(origin.y, window.innerHeight - requestedHeight - header.offsetHeight))
        apply({
            width: Math.round(clamp(requestedWidth, minimum.width, Math.max(minimum.width, window.innerWidth - origin.x))),
            height: Math.round(clamp(requestedHeight, minimum.height,
                Math.max(minimum.height, window.innerHeight - origin.y - header.offsetHeight)))
        })
    }
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
                if (resizable !== false) {
                    popped.own(Events.subscribe(popped.owner, "resize", () =>
                        resize(popped.owner.innerWidth, popped.owner.innerHeight - header.offsetHeight)))
                }
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
    if (isDefined(adjust)) {request({width: bodyWidth, height: bodyHeight})}
    return {size, owner, togglePopout, resetSize, requestSize, toFront, close}
}
