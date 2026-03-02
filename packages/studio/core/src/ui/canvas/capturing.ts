import {Nullable} from "@opendaw/lib-std"

export interface Capturing<T> {capture(localX: number, localY: number): Nullable<T>}

export class ElementCapturing<T> {
    readonly #element: Element
    readonly #capturing: Capturing<T>

    constructor(element: Element, capturing: Capturing<T>) {
        this.#element = element
        this.#capturing = capturing
    }

    get element(): Element {return this.#element}
    get capturing(): Capturing<T> {return this.#capturing}

    captureEvent(event: { clientX: number, clientY: number }): Nullable<T> {
        return this.capturePoint(event.clientX, event.clientY)
    }

    capturePoint(clientX: number, clientY: number): Nullable<T> {
        const {left, top} = this.#element.getBoundingClientRect()
        return this.captureLocalPoint(clientX - left, clientY - top)
    }

    captureLocalPoint(x: number, y: number): Nullable<T> {return this.#capturing.capture(x, y)}
}