import css from "./FloatingWindow.sass?inline"
import {
    clamp, DefaultObservableValue, Exec, Func, int, isDefined, isNull, Nullable, ObservableValue, Option, Optional, Point, safeExecute, Size, Terminator
} from "@opendaw/lib-std"
import {createElement, JsxValue} from "@opendaw/lib-jsx"
import {Dragging, Events, Html} from "@opendaw/lib-dom"
import {Button} from "@/ui/components/Button.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {Surface} from "@/ui/surface/Surface.tsx"
import {Layers} from "@/ui/surface/Layers.tsx"

const className = Html.adoptStyleSheet(css, "FloatingWindow")

type Construct = {
    title: string
    icon?: IconSymbol
    width: int
    height: int
    position?: Point
    resizable?: boolean
    keepAspectRatio?: boolean
    minWidth?: int
    minHeight?: int
    adjust?: Func<Size, Promise<Size>>
    onClose?: Exec
}

export interface FloatingWindowHandle {
    readonly size: ObservableValue<Size>
    resetSize(): void
    close(): void
}

type ResizeAxis = { x: boolean, y: boolean }
type Adjusting = { busy: boolean, closed: boolean, next: Nullable<Size> }

export const FloatingWindow = ({
                                   title, icon, width, height, position, resizable, keepAspectRatio, minWidth, minHeight, adjust,
                                   onClose
                               }: Construct, children: JsxValue): FloatingWindowHandle => {
    const lifecycle = new Terminator()
    const surface = Surface.get()
    const ratio: Optional<number> = keepAspectRatio === true ? width / height : undefined
    const minimum: Size = {width: minWidth ?? 120, height: minHeight ?? 80}
    const adjusting: Adjusting = {busy: false, closed: false, next: null}
    const fitScale = Math.max(Math.min(1, (window.innerWidth - 32) / width, (window.innerHeight - 64) / height),
        minimum.width / width, minimum.height / height)
    const bodyWidth = isDefined(ratio)
        ? Math.round(width * fitScale) : Math.max(minimum.width, Math.min(width, window.innerWidth - 32))
    const bodyHeight = isDefined(ratio)
        ? Math.round(height * fitScale) : Math.max(minimum.height, Math.min(height, window.innerHeight - 64))
    const size = lifecycle.own(new DefaultObservableValue<Size>({width: bodyWidth, height: bodyHeight}))
    const origin = isDefined(position)
        ? {x: position.x, y: position.y}
        : {x: (window.innerWidth - bodyWidth) * 0.5, y: (window.innerHeight - bodyHeight) * 0.5}
    const header: HTMLElement = (
        <header>
            {isDefined(icon) && <Icon symbol={icon}/>}
            <span>{title}</span>
            {resizable !== false && (
                <Button lifecycle={lifecycle} onClick={() => resetSize()}
                        appearance={{color: Colors.shadow, tooltip: "Original size"}}>
                    <span className="reset">100%</span>
                </Button>
            )}
            <Button lifecycle={lifecycle} onClick={() => close()} appearance={{color: Colors.shadow, tooltip: "Close"}}>
                <Icon symbol={IconSymbol.Close}/>
            </Button>
        </header>
    )
    const body: HTMLElement = <div className="body">{children}</div>
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
        origin.x = clamp(x, 0, Math.max(0, window.innerWidth - element.offsetWidth))
        origin.y = clamp(y, 0, Math.max(0, window.innerHeight - header.offsetHeight))
        element.style.left = `${origin.x}px`
        element.style.top = `${origin.y}px`
    }
    const fitRatio = (width: number, ratio: number, maxWidth: number, maxHeight: number): Size => {
        const lower = Math.max(minimum.width, minimum.height * ratio)
        const upper = Math.max(lower, Math.min(maxWidth, maxHeight * ratio))
        const fitted = clamp(width, lower, upper)
        return {width: Math.round(fitted), height: Math.round(fitted / ratio)}
    }
    const resize = (width: number, height: number) => {
        const maxWidth = Math.max(minimum.width, window.innerWidth - origin.x)
        const maxHeight = Math.max(minimum.height, window.innerHeight - origin.y - header.offsetHeight)
        const next: Size = isDefined(ratio)
            ? fitRatio(width, ratio, maxWidth, maxHeight)
            : {
                width: Math.round(clamp(width, minimum.width, maxWidth)),
                height: Math.round(clamp(height, minimum.height, maxHeight))
            }
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
            negotiate()
        }, () => adjusting.busy = false)
    }
    const resetSize = () => {
        move(Math.min(origin.x, window.innerWidth - width), Math.min(origin.y, window.innerHeight - height - header.offsetHeight))
        resize(width, height)
    }
    const close = () => {
        adjusting.closed = true
        lifecycle.terminate()
        element.remove()
        safeExecute(onClose)
    }
    lifecycle.own(Dragging.attach(header, (beginEvent: PointerEvent) => {
        if (beginEvent.target instanceof Element && beginEvent.target.closest("[data-class='button']") !== null) {return Option.None}
        const startX = origin.x - beginEvent.clientX
        const startY = origin.y - beginEvent.clientY
        return Option.wrap({update: (event: Dragging.Event) => move(startX + event.clientX, startY + event.clientY)})
    }))
    grips.forEach(([grip, axis]) => lifecycle.own(Dragging.attach(grip, (beginEvent: PointerEvent) => {
        const {width: startWidth, height: startHeight} = size.getValue()
        return Option.wrap({
            update: (event: Dragging.Event) => {
                const width = axis.x ? startWidth + event.clientX - beginEvent.clientX : startWidth
                const height = axis.y ? startHeight + event.clientY - beginEvent.clientY : startHeight
                if (!isDefined(ratio)) {return resize(width, height)}
                const ratioWidth = axis.x && axis.y ? Math.max(width, height * ratio) : axis.x ? width : height * ratio
                resize(ratioWidth, ratioWidth / ratio)
            }
        })
    })))
    lifecycle.own(Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
        const onButton = event.target instanceof Element && event.target.closest("[data-class='button']") !== null
        if (!onButton && surface.floating.lastElementChild !== element) {surface.floating.appendChild(element)}
    }, {capture: true}))
    lifecycle.own(Events.subscribe(window, "resize", () => move(origin.x, origin.y)))
    body.style.width = `${bodyWidth}px`
    body.style.height = `${bodyHeight}px`
    surface.floating.appendChild(element)
    move(origin.x, origin.y)
    return {size, resetSize, close}
}
