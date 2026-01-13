import css from "./Scroller.sass?inline"
import {Lifecycle, Option} from "@moises-ai/lib-std"
import {Dragging, Html} from "@moises-ai/lib-dom"
import {createElement} from "@moises-ai/lib-jsx"
import {ScrollModel} from "@/ui/components/ScrollModel.ts"

export enum Orientation {vertical = "vertical", horizontal = "horizontal"}

type Properties = {
    position: "left" | "top"
    size: "width" | "height"
    clientPointer: "clientX" | "clientY"
    clientSize: "clientWidth" | "clientHeight"
}

const OrientationProperties = {
    [Orientation.vertical]: {
        position: "top",
        size: "height",
        clientPointer: "clientY",
        clientSize: "clientHeight"
    } satisfies Properties,
    [Orientation.horizontal]: {
        position: "left",
        size: "width",
        clientPointer: "clientX",
        clientSize: "clientWidth"
    } satisfies Properties
}

const className = Html.adoptStyleSheet(css, "Scroller")

type Construct = {
    lifecycle: Lifecycle
    model: ScrollModel
    orientation?: Orientation
    floating?: boolean
}

export const Scroller = ({lifecycle, model, orientation, floating}: Construct) => {
    orientation ??= Orientation.vertical
    floating ??= false
    const props: Properties = OrientationProperties[orientation]
    const thumb: HTMLElement = <div/>
    const element: HTMLElement = (
        <div className={Html.buildClassList(className, orientation, floating && "floating")}>{thumb}</div>
    )
    const update = () => {
        thumb.style.visibility = model.scrollable() ? "visible" : "hidden"
        thumb.style[props.position] = `${model.thumbPosition + 1}px`
        thumb.style[props.size] = `${model.thumbSize - 2}px`
    }
    lifecycle.own(model.subscribe(update))
    lifecycle.own(Dragging.attach(element, (event: PointerEvent) => {
        let trackPosition = event[props.clientPointer] - element.getBoundingClientRect()[props.position]
        const delta = event.target === thumb ? trackPosition - model.thumbPosition : model.thumbSize / 2
        model.moveTo(trackPosition - delta)
        return Option.wrap({
            update: (event: Dragging.Event): void => {
                trackPosition = event[props.clientPointer] - element.getBoundingClientRect()[props.position]
                model.moveTo(trackPosition - delta)
            }
        })
    }))
    update()
    lifecycle.own(Html.watchResize(element, () => model.trackSize = element[props.clientSize]))
    return element
}