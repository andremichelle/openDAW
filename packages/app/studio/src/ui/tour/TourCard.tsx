import css from "./TourCard.sass?inline"
import ringCss from "./TourRing.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Exec, isDefined, Optional} from "@opendaw/lib-std"
import {Html} from "@opendaw/lib-dom"
import {IconSymbol} from "@opendaw/studio-enums"
import {Icon} from "@/ui/components/Icon"
import {CardLayout, Rect, Size} from "./TourPlacement"

const className = Html.adoptStyleSheet(css, "TourCard")
const ringClassName = Html.adoptStyleSheet(ringCss, "TourRing")

type Construct = {
    onClose: Exec
    onNext: Exec
}

export type TourCardContent = {
    headline: string
    text: string
    index: number
    count: number
}

export class TourCard {
    readonly #element: HTMLElement
    readonly #notch: HTMLElement
    readonly #headline: HTMLElement
    readonly #text: HTMLElement
    readonly #counter: HTMLElement
    readonly #nextLabel: HTMLElement
    readonly #nextButton: HTMLButtonElement
    readonly #ring: HTMLElement

    constructor({onClose, onNext}: Construct) {
        this.#notch = <div className="notch"/>
        this.#headline = <h1/>
        this.#text = <p/>
        this.#counter = <span/>
        this.#nextLabel = <span>Next</span>
        this.#ring = <div className={Html.buildClassList(ringClassName, "hidden")}/>
        this.#nextButton = <button className="next" onclick={onNext}>{this.#nextLabel}<kbd>→</kbd></button>
        this.#element = (
            <div className={className}>
                {this.#notch}
                <header>
                    {this.#headline}
                    <button className="close" onclick={onClose} title="Close tour (Esc)">
                        <Icon symbol={IconSymbol.Close}/>
                    </button>
                </header>
                {this.#text}
                <footer>
                    {this.#counter}
                    {this.#nextButton}
                </footer>
            </div>
        )
    }

    get element(): HTMLElement {return this.#element}
    get ring(): HTMLElement {return this.#ring}

    update({headline, text, index, count}: TourCardContent): void {
        this.#headline.textContent = headline
        this.#text.textContent = text
        this.#counter.textContent = `${index + 1} / ${count}`
        const last = index + 1 === count
        this.#nextLabel.textContent = last ? "Finish" : "Next"
        this.#nextButton.title = last ? "Finish the tour (→ or Enter)" : "Next card (→ or Enter)"
    }

    measure(): Size {
        this.#element.classList.add("measuring")
        const {width, height} = this.#element.getBoundingClientRect()
        return {width, height}
    }

    layout({x, y, side, notch}: CardLayout, frame: Optional<Rect>): void {
        this.#element.style.transform = `translate(${x}px, ${y}px)`
        if (isDefined(frame)) {
            this.#ring.style.transform = `translate(${frame.x}px, ${frame.y}px)`
            this.#ring.style.width = `${frame.width}px`
            this.#ring.style.height = `${frame.height}px`
            this.#ring.classList.remove("hidden")
        } else {
            this.#ring.classList.add("hidden")
        }
        if (isDefined(side)) {
            this.#element.setAttribute("data-side", side)
            const vertical = side === "above" || side === "below"
            this.#notch.style.left = vertical ? `${notch}px` : ""
            this.#notch.style.top = vertical ? "" : `${notch}px`
            this.#notch.classList.remove("hidden")
        } else {
            this.#element.removeAttribute("data-side")
            this.#notch.classList.add("hidden")
        }
        this.#element.classList.remove("measuring")
        this.#nextButton.focus({preventScroll: true})
    }
}
