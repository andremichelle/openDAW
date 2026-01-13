import {Events, Keyboard} from "@moises-ai/lib-dom"
import {isDefined, Nullable, Terminable, Terminator} from "@moises-ai/lib-std"

export class HTMLSelection implements Terminable {
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
                    const nodes = Array.from<Element>(this.#container.children)
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
    #find(target: Nullable<EventTarget>): Nullable<Element> {
        if (target === this.#container) {return null}
        while (target instanceof Element) {
            if (target.parentElement === this.#container) {
                return target
            }
            target = target.parentElement
        }
        return null
    }
}