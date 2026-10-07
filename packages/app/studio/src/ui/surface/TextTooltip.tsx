import css from "./TextTooltip.sass?inline"
import {Layers} from "./Layers"
import {createElement} from "@opendaw/lib-jsx"
import {getOrProvide, Provider, Terminable, ValueOrProvider} from "@opendaw/lib-std"
import {AbstractTooltip} from "@/ui/surface/AbstractTooltip.ts"
import {Events, Html} from "@opendaw/lib-dom"

export interface Data {
    text: ValueOrProvider<string>
    clientX: number
    clientY: number
}

export class TextTooltip extends AbstractTooltip<Data> {
    static simple(element: Element, provider: Provider<Data>): Terminable {
        return Terminable.many(
            Events.subscribe(element, "pointerdown", () => {
                if (!this.enabled) {return}
                const layers = Layers.get(element)
                layers.textTooltip.show(provider)
                Events.subscribe(element, "pointerleave", () => layers.textTooltip.hide(), {once: true})
            }, {capture: true}),
            Events.subscribe(element, "pointerover", () => {
                if (!this.enabled) {return}
                const layers = Layers.get(element)
                layers.textTooltip.show(provider)
                Events.subscribe(element, "pointerleave", () => layers.textTooltip.hide(), {once: true})
            }, {capture: true}),
            Terminable.create(() => Layers.get(element).textTooltip.forceHide())
        )
    }

    static default(element: Element, provider: Provider<string>): Terminable {
        return this.simple(element, () => {
            const clientRect = element.getBoundingClientRect()
            return {
                clientX: clientRect.left,
                clientY: clientRect.bottom + 8,
                text: provider()
            }
        })
    }

    static enabled: boolean = true

    // DO NOT INLINE: This sheet needs to be initialized upfront to be copied over to new documents
    static readonly #CLASS_NAME = Html.adoptStyleSheet(css, "TextTooltip")

    constructor(layers: Layers) {
        super(layers)
    }

    protected createElement(): HTMLElement {return (<div className={TextTooltip.#CLASS_NAME}/>)}
    protected showDelayInFrames(): number {return 45}
    protected hideDelayInFrames(): number {return 15}

    update({text}: Data): void {this.element.textContent = getOrProvide(text)}
}