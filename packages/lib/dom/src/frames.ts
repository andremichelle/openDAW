import {Exec, int, Nullable, Terminable} from "@moises-ai/lib-std"

export namespace AnimationFrame {
    const nonrecurring = new Set<Exec>()
    const recurring = new Set<Exec>()
    const queue = new Array<Exec>()

    let id: int = -1
    let driver: Nullable<WindowProxy> = null

    export const add = (exec: Exec): Terminable => {
        recurring.add(exec)
        return {terminate: (): unknown => recurring.delete(exec)}
    }

    export const once = (exec: Exec): void => {nonrecurring.add(exec)}

    export const start = (owner: WindowProxy): void => {
        if (driver === owner) {return}
        driver?.cancelAnimationFrame(id)
        driver = owner
        id = owner.requestAnimationFrame(exe)
    }

    export const stop = (): void => {
        driver?.cancelAnimationFrame(id)
        driver = null
        id = -1
    }

    export const terminate = (): void => {
        stop()
        queue.length = 0
        recurring.clear()
        nonrecurring.clear()
    }

    const exe = (): void => {
        if (recurring.size > 0 || nonrecurring.size > 0) {
            recurring.forEach((exec: Exec) => queue.push(exec))
            nonrecurring.forEach((exec: Exec) => queue.push(exec))
            nonrecurring.clear()
            queue.forEach((exec: Exec) => exec())
            queue.length = 0
        }
        id = driver?.requestAnimationFrame(exe) ?? -1
    }
}

export const deferNextFrame = (exec: Exec): DeferExec => new DeferExec(exec)

export class DeferExec implements Terminable {
    readonly #exec: Exec

    #requested: boolean = false
    #disabled: boolean = false

    constructor(exec: Exec) {this.#exec = exec}

    readonly request = (): void => {
        if (this.#requested || this.#disabled) {return}
        this.#requested = true
        AnimationFrame.once(this.#fire)
    }

    readonly immediate = (): void => {
        if (this.#disabled) {return}
        this.#requested = true
        this.#fire()
    }

    cancel(): void {this.#requested = false}
    terminate(): void {this.#disabled = true }

    readonly #fire = (): void => {
        if (this.#disabled || !this.#requested) {return}
        this.#requested = false
        this.#exec()
    }
}