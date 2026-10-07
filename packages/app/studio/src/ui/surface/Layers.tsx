import css from "./Layers.sass?inline"
import {asDefined, Option, Point, tryCatch} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Surface} from "@/ui/surface/Surface.tsx"
import {TextTooltip} from "@/ui/surface/TextTooltip.tsx"
import {ValueTooltip} from "@/ui/surface/ValueTooltip.tsx"

const className = Html.adoptStyleSheet(css, "Layers")
const CONTAINER_ATTRIBUTE = "data-layers"

// One flyout layer per container (surface, dialog, floating window) so menus and tooltips render above its content
export class Layers {
    static readonly #byContainer = new WeakMap<Element, Layers>()
    static readonly #byFlyout = new WeakMap<Element, Layers>()

    static root(surface: Surface): Layers {
        const layers = new Layers(Option.wrap(surface), <div className="flyout"/>)
        this.#byFlyout.set(layers.#flyout, layers)
        return layers
    }

    static install(container: HTMLElement): Layers {
        const flyout: DomElement = <div className={className}/>
        container.setAttribute(CONTAINER_ATTRIBUTE, "")
        container.appendChild(flyout)
        const layers = new Layers(Option.None, flyout)
        this.#byContainer.set(container, layers)
        this.#byFlyout.set(flyout, layers)
        return layers
    }

    static get(element: Element): Layers {
        const container = element.closest(`[${CONTAINER_ATTRIBUTE}]`)
        return container === null
            ? Surface.get(element).layers
            : asDefined(this.#byContainer.get(container), "Layers container not registered")
    }

    static nestedOrigin(flyout: Element): Option<Point> {
        return Option.wrap(this.#byFlyout.get(flyout)).flatMap(layers => layers.isNested ? Option.wrap(layers.origin) : Option.None)
    }

    readonly #surface: Option<Surface>
    readonly #flyout: DomElement
    readonly #textTooltip: TextTooltip
    readonly #valueTooltip: ValueTooltip

    private constructor(surface: Option<Surface>, flyout: DomElement) {
        this.#surface = surface
        this.#flyout = flyout
        this.#textTooltip = new TextTooltip(this)
        this.#valueTooltip = new ValueTooltip(this)
    }

    get surface(): Surface {return this.#surface.unwrapOrElse(() => Surface.get(this.#flyout))}
    get isNested(): boolean {return this.#surface.isEmpty()}
    get textTooltip(): TextTooltip {return this.#textTooltip}
    get valueTooltip(): ValueTooltip {return this.#valueTooltip}
    get hasFlyout(): boolean {return this.#flyout.firstChild !== null}
    get origin(): Point {
        if (!this.isNested) {return Point.zero()}
        const {left, top} = this.#flyout.getBoundingClientRect()
        return {x: left, y: top}
    }
    get width(): number {return this.isNested ? this.#flyout.getBoundingClientRect().width : this.surface.width}
    get height(): number {return this.isNested ? this.#flyout.getBoundingClientRect().height : this.surface.height}
    get flyout(): DomElement {
        const toRemove = Array.from(this.#flyout.children)
        /**
         * We need to postpone this due to an unexpected browser behavior.
         * For some unknown reason <code>Html.empty(this.#flyout)</code> will lead to:
         *
         * NotFoundError: Failed to execute 'remove' on 'Element':
         * The node to be removed is no longer a child of this node. Perhaps it was moved in a 'blur' event handler?
         *
         * If anybody can explain why this code thrown an error, I owe you a beer.
         * The intention of this code is to allow only one flyout.
         */
        AnimationFrame.once(() => toRemove.forEach(element => {
            const {status, error} = tryCatch(() => {if (element.isConnected) {element.remove()}})
            if (status === "failure") {console.warn(error)}
        }))
        return this.#flyout
    }
}
