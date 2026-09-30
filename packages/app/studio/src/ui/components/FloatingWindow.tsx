import css from "./FloatingWindow.sass?inline"
import {clamp, Exec, int, isDefined, Option, Point, safeExecute, Terminator} from "@opendaw/lib-std"
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
    onClose?: Exec
}

export interface FloatingWindowHandle {
    close(): void
}

export const FloatingWindow = ({title, icon, width, height, position, onClose}: Construct, children: JsxValue): FloatingWindowHandle => {
    const lifecycle = new Terminator()
    const surface = Surface.get()
    const origin = position ?? {x: (window.innerWidth - width) * 0.5, y: (window.innerHeight - height) * 0.5}
    const header: HTMLElement = (
        <header>
            {isDefined(icon) && <Icon symbol={icon}/>}
            <span>{title}</span>
            <Button lifecycle={lifecycle} onClick={() => close()} appearance={{color: Colors.shadow, tooltip: "Close"}}>
                <Icon symbol={IconSymbol.Close}/>
            </Button>
        </header>
    )
    const element: HTMLElement = (
        <div className={className}>
            {header}
            <div className="body" style={{width: `${width}px`, height: `${height}px`}}>{children}</div>
        </div>
    )
    Layers.install(element)
    const move = (x: number, y: number) => {
        origin.x = clamp(x, 0, Math.max(0, window.innerWidth - element.offsetWidth))
        origin.y = clamp(y, 0, Math.max(0, window.innerHeight - header.offsetHeight))
        element.style.left = `${origin.x}px`
        element.style.top = `${origin.y}px`
    }
    const close = () => {
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
    lifecycle.own(Events.subscribe(element, "pointerdown", (event: PointerEvent) => {
        const onButton = event.target instanceof Element && event.target.closest("[data-class='button']") !== null
        if (!onButton && surface.floating.lastElementChild !== element) {surface.floating.appendChild(element)}
    }, {capture: true}))
    lifecycle.own(Events.subscribe(window, "resize", () => move(origin.x, origin.y)))
    surface.floating.appendChild(element)
    move(origin.x, origin.y)
    return {close}
}
