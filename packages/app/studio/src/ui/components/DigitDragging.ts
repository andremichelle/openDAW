import {Dragging} from "@opendaw/lib-dom"
import {Exec, Option, Procedure, Provider, Terminable} from "@opendaw/lib-std"

export namespace DigitDragging {
    export interface Hooks {
        begin: Exec
        end: Exec
    }

    export const Ratio = 0.25
    export const FineRatio = 0.25

    export const install = (target: HTMLElement,
                            unit: number,
                            read: Provider<number>,
                            write: Procedure<number>,
                            hooks: Hooks): Terminable =>
        Dragging.attach(target, (event: PointerEvent) => {
            if (document.activeElement === target) {return Option.None}
            const startValue = read()
            let lastY = event.clientY
            let delta = 0.0
            let moved = false
            hooks.begin()
            return Option.wrap({
                update: ({clientY, altKey}: Dragging.Event): void => {
                    delta += (lastY - clientY) * (altKey ? FineRatio : 1.0)
                    lastY = clientY
                    const steps = Math.round(delta * Ratio)
                    if (steps === 0 && !moved) {return}
                    moved = true
                    write(startValue + steps * unit)
                },
                cancel: () => write(startValue),
                finally: () => {
                    if (moved) {target.blur()}
                    hooks.end()
                }
            })
        }, {pointerLock: true})
}
