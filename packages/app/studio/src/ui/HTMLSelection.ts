import {Events, Keyboard} from "@opendaw/lib-dom"
import {isDefined, Nullable, Terminable, Terminator} from "@opendaw/lib-std"

export class HTMLSelection implements Terminable {
    static readonly #EntrySelector = "[data-selection]"

    readonly #terminator = new Terminator()
    readonly #container: HTMLElement

    #lastSelection: Nullable<Element> = null

    constructor(container: HTMLElement) {
        this.#container = container

        this.#terminator.own(Events.subscribe(this.#container, "pointerdown", (event: PointerEvent) => {
            const target = this.#find(event.target)
            if (isDefined(target)) {
                if (Keyboard.isControlKey(event)) {
                    target.classList.toggle("selected")
                } else if (event.shiftKey) {
                    const nodes = this.#entries()
                    if (nodes.length === 0) {return}
                    let lastSelection = this.#lastSelection ?? nodes[0]
                    const i0 = nodes.indexOf(target)
                    const i1 = nodes.indexOf(lastSelection)
                    const n = Math.max(i0, i1)
                    for (let i = Math.min(i0, i1); i <= n; i++) {
                        nodes[i].classList.add("selected")
                    }
                } else if (!target.classList.contains("selected")) {
                    this.#unselectAll()
                    this.#select(target)
                }
            }
        }))
    }

    getSelected(): ReadonlyArray<Element> {return Array.from(this.#container.querySelectorAll(".selected"))}

    clear(): void {
        this.#lastSelection = null
    }

    terminate(): void {this.#terminator.terminate()}

    #select(element: Element): void {
        element.classList.toggle("selected")
        this.#lastSelection = element
    }

    #unselectAll(): void {
        this.#container.querySelectorAll(".selected")
            .forEach((element: Element) => {element.classList.remove("selected")})
    }
    // Entries are marked by `data-selection`, not by being a direct child: folders nest them one level deeper
    // and a range must still run across folder boundaries in visual order.
    #entries(): ReadonlyArray<Element> {
        return Array.from(this.#container.querySelectorAll(HTMLSelection.#EntrySelector))
            .filter(element => !isDefined(element.closest(".hidden")))
    }

    #find(target: Nullable<EventTarget>): Nullable<Element> {
        if (target === this.#container) {return null}
        while (target instanceof Element) {
            if (target.matches(HTMLSelection.#EntrySelector) && this.#container.contains(target)) {
                return target
            }
            target = target.parentElement
        }
        return null
    }
}