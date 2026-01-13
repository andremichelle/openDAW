import {Dragging, Events, Html} from "@moises-ai/lib-dom"
import {assert, Notifier, Observer, Option, Point, Subscription, Terminable, Terminator} from "@moises-ai/lib-std"

export class Camera implements Terminable {
    readonly #element: HTMLElement

    readonly #terminator: Terminator
    readonly #notifier: Notifier<Camera>

    #x: number = 0
    #y: number = 0
    #scale: number = 1 // TODO 2 will break when deleting a module and undo (wire is misplaced)
    #listening: boolean = false

    constructor(element: HTMLElement) {
        this.#element = element

        this.#terminator = new Terminator()
        this.#notifier = this.#terminator.own(new Notifier<Camera>())
        this.#terminator.own(Html.watchResize(this.#element, () => this.#update()))
    }

    set(x: number, y: number): void {
        this.#x = Math.round(x)
        this.#y = Math.round(y)
        this.#update()
    }

    globalToLocal(x: number, y: number): Point {
        const clientRect = this.#element.getBoundingClientRect()
        return {
            x: Math.round(x - (clientRect.x + clientRect.width * 0.5 - this.#x)),
            y: Math.round(y - (clientRect.y + clientRect.height * 0.5 - this.#y))
        }
    }

    localToGlobal(x: number, y: number): Point {
        const clientRect = this.#element.getBoundingClientRect()
        return {
            x: x + (clientRect.x + clientRect.width * 0.5 - this.#x),
            y: y + (clientRect.y + clientRect.height * 0.5 - this.#y)
        }
    }

    get x(): number {return this.#x}
    get y(): number {return this.#y}
    get scale(): number {return this.#scale}

    listen(): void {
        assert(!this.#listening, "You cannot call listen() twice.")
        this.#listening = true
        this.#terminator.own(Dragging.attach(this.#element, (event: PointerEvent) => {
            const startX = this.#x
            const startY = this.#y
            const pointerX = event.clientX
            const pointerY = event.clientY
            return Option.wrap({
                update: (event: Dragging.Event) =>
                    this.set(startX + (pointerX - event.clientX) / this.#scale, startY + (pointerY - event.clientY) / this.#scale),
                cancel: () =>
                    this.set(this.#x, this.#y)
            })
        }))
        if (window.matchMedia("(pointer: fine)").matches) {
            this.#terminator.own(Events.subscribe(this.#element, "wheel", event =>
                this.set(this.#x + event.deltaX / this.#scale, this.#y + event.deltaY / this.#scale), {passive: true}))
        }
    }

    subscribe(observer: Observer<Camera>): Subscription {return this.#notifier.subscribe(observer)}
    terminate(): void {this.#notifier.terminate()}

    #update(): void {
        this.#element.style.setProperty("--x", `calc(50% + ${-this.#x}px)`)
        this.#element.style.setProperty("--y", `calc(50% + ${-this.#y}px)`)
        this.#element.style.setProperty("--scale", `${this.#scale}`)
        this.#notifier.notify(this)
    }
}