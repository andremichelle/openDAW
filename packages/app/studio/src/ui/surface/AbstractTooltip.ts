import {AnimationFrame} from "@moises-ai/lib-dom"
import {Surface} from "./Surface"
import {int, Option, Provider, Terminable} from "@moises-ai/lib-std"

export type ClientPosition = { clientX: number, clientY: number }

export abstract class AbstractTooltip<DATA extends ClientPosition> {
    readonly #surface: Surface

    readonly #element: HTMLElement

    #current: Option<{ updater: Terminable, provider: Provider<DATA> }> = Option.None
    #stopDelay: Option<Terminable> = Option.None

    protected constructor(surface: Surface) {
        this.#surface = surface

        this.#element = this.createElement()
    }

    protected abstract createElement(): HTMLElement
    protected abstract update(data: DATA): void
    protected abstract showDelayInFrames(): int
    protected abstract hideDelayInFrames(): int

    show(provider: Provider<DATA>): void {
        this.#stopDelay.ifSome(delay => delay.terminate())
        this.#stopDelay = Option.None
        if (this.#current.isEmpty()) {
            this.#current = Option.wrap({updater: this.#startDeplayed(provider), provider})
        } else if (this.#current.unwrap().provider === provider) {
            if (this.#element.isConnected) {
                return
            } else if (!this.#surface.hasFlyout) {
                this.#attach()
                this.#current.ifSome(({updater}) => updater.terminate())
                this.#current = Option.wrap({updater: this.#start(provider), provider})
            }
        } else {
            this.#current.ifSome(({updater}) => updater.terminate())
            if (this.#element.isConnected) {
                this.#current = Option.wrap({updater: this.#start(provider), provider})
            } else {
                this.#current = Option.wrap({updater: this.#startDeplayed(provider), provider})
            }
        }
    }

    hide(): void {
        if (this.#stopDelay.isEmpty()) {
            this.#stopDelay = Option.wrap(AnimationFrame.add((() => {
                let frame = 0
                return () => {
                    if (++frame === this.hideDelayInFrames()) {
                        this.#stopDelay.ifSome(delay => delay.terminate())
                        this.#stopDelay = Option.None
                        this.#stop()
                    }
                }
            })()))
        }
    }

    forceHide(): void {this.#stop()}

    get element(): HTMLElement {return this.#element}

    #start(provider: Provider<DATA>): Terminable {
        return AnimationFrame.add(() => this.#update(provider()))
    }

    #startDeplayed(provider: Provider<DATA>): Terminable {
        return AnimationFrame.add((() => {
            let frame = 0
            return () => {
                if (++frame === this.showDelayInFrames()) {
                    if (this.#surface.hasFlyout) {
                        this.#stop()
                    } else {
                        this.#attach()
                    }
                }
                if (frame >= this.showDelayInFrames()) {
                    this.#update(provider())
                }
            }
        })())
    }

    #update(data: DATA): void {
        this.update(data)
        let clientX = data.clientX
        let clientY = data.clientY
        if (clientX + this.#element.clientWidth > this.#surface.width) {
            clientX = this.#surface.width - this.#element.clientWidth
        }
        if (clientY + this.#element.clientHeight > this.#surface.height) {
            clientY = this.#surface.height - this.#element.clientHeight
        }
        this.#element.style.transform = `translate(${clientX}px, ${clientY}px)`
    }

    #stop(): void {
        this.#detach()
        this.#current.ifSome(({updater}) => updater.terminate())
        this.#current = Option.None
        this.#stopDelay.ifSome(delay => delay.terminate())
        this.#stopDelay = Option.None
    }

    #attach(): void {
        this.#surface.flyout.appendChild(this.#element)
        this.#element.focus()
    }

    #detach(): void {
        if (this.#element.isConnected) {this.#element.remove()}
    }
}