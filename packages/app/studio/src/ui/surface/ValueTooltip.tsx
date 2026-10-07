import css from "./ValueTooltip.sass?inline"
import {Layers} from "./Layers"
import {createElement} from "@opendaw/lib-jsx"
import {PrintValue, Provider, Terminable} from "@opendaw/lib-std"
import {AbstractTooltip} from "@/ui/surface/AbstractTooltip.ts"
import {Events, Html} from "@opendaw/lib-dom"

export interface ValueData extends PrintValue {
    clientX: number
    clientY: number
}

export class ValueTooltip extends AbstractTooltip<ValueData> {
    static default(element: Element, provider: Provider<ValueData>): Terminable {
        return Terminable.many(
            Events.subscribe(element, "pointerdown", () => {
                const layers = Layers.get(element)
                layers.valueTooltip.show(provider)
                Events.subscribe(element, "pointerleave", () => layers.valueTooltip.hide(), {once: true})
            }),
            Events.subscribe(element, "pointerenter", () => {
                const layers = Layers.get(element)
                layers.valueTooltip.show(provider)
                Events.subscribe(element, "pointerleave", () => layers.valueTooltip.hide(), {once: true})
            }),
            Terminable.create(() => Layers.get(element).textTooltip.forceHide())
        )
    }

    // DO NOT INLINE: This sheet needs to be initialized upfront to be copied over to new documents
    static readonly #CLASS_NAME = Html.adoptStyleSheet(css, "ValueTooltip")

    constructor(layers: Layers) {super(layers)}

    protected createElement(): HTMLElement {return (<div className={ValueTooltip.#CLASS_NAME}/>)}
    protected showDelayInFrames(): number {return 30}
    protected hideDelayInFrames(): number {return 20}

    update({value, unit}: ValueData): void {
        this.element.setAttribute("unit", unit)
        this.element.textContent = value
    }
}