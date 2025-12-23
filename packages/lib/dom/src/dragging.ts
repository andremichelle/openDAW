import {EmptyExec, Func, int, isDefined, Option, safeRead, Terminable, Terminator} from "@opendaw/lib-std"
import {Browser} from "./browser"
import {AnimationFrame} from "./frames"
import {Events, PointerCaptureTarget} from "./events"
import {Keyboard} from "./keyboard"

export namespace Dragging {
    export interface Process {
        update(event: Event): void
        cancel?(): void
        approve?(): void
        finally?(): void
        abortSignal?: AbortSignal
    }

    export interface Event {
        readonly clientX: number
        readonly clientY: number
        readonly altKey: boolean
        readonly shiftKey: boolean
        readonly ctrlKey: boolean
    }

    export interface ProcessOptions {
        multiTouch?: boolean
        immediate?: boolean
        permanentUpdates?: boolean
        pointerLock?: boolean
        pointerLockThreshold?: number
    }

    export let usePointerLock = false

    export const attach = <T extends PointerCaptureTarget>(target: T,
                                                           factory: Func<PointerEvent, Option<Process>>,
                                                           options?: ProcessOptions): Terminable => {
        const processCycle = new Terminator()
        return Terminable.many(processCycle, Events.subscribe(target, "pointerdown", (event: PointerEvent) => {
            if (options?.multiTouch !== true && !event.isPrimary) {return}
            if (event.buttons !== 1 || (Browser.isMacOS() && event.ctrlKey)) {return}
            const option: Option<Process> = factory(event)
            if (option.isEmpty()) {return}
            const process: Process = option.unwrap()
            const pointerId: int = event.pointerId
            event.stopPropagation()
            event.stopImmediatePropagation()
            try {
                target.setPointerCapture(pointerId)
            } catch (_) {return}

            // Pointer lock configuration
            const usePointerLock = options?.pointerLock === true && Dragging.usePointerLock
            const threshold = options?.pointerLockThreshold ?? 16
            const targetElement = target instanceof Element ? target : null
            let pointerLockActive = false

            const requestPointerLockIfNeeded = (clientX: number, clientY: number): void => {
                if (!usePointerLock || targetElement === null || pointerLockActive) {return}

                // Check if the pointer is near window edges
                const nearLeft = clientX < threshold
                const nearRight = clientX > window.innerWidth - threshold
                const nearTop = clientY < threshold
                const nearBottom = clientY > window.innerHeight - threshold

                if (nearLeft || nearRight || nearTop || nearBottom) {
                    targetElement.requestPointerLock().then(() => pointerLockActive = true, EmptyExec)
                }
            }

            const moveEvent = {
                clientX: event.clientX,
                clientY: event.clientY,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                ctrlKey: Keyboard.isControlKey(event)
            } satisfies Event
            if (options?.immediate === true) {
                process.update(moveEvent)
            }
            if (options?.permanentUpdates === true) {
                processCycle.own(AnimationFrame.add(() => process.update(moveEvent)))
                processCycle.own(Events.subscribe(target, "pointermove", (event: PointerEvent) => {
                    if (event.pointerId === pointerId) {
                        // Accumulate movement deltas into clientX/Y when the pointer is locked
                        if (targetElement !== null && document.pointerLockElement === targetElement) {
                            moveEvent.clientX += event.movementX
                            moveEvent.clientY += event.movementY
                        } else {
                            moveEvent.clientX = event.clientX
                            moveEvent.clientY = event.clientY
                            requestPointerLockIfNeeded(event.clientX, event.clientY)
                        }
                        moveEvent.altKey = event.altKey
                        moveEvent.shiftKey = event.shiftKey
                        moveEvent.ctrlKey = Keyboard.isControlKey(event)
                    }
                }))
            } else {
                processCycle.own(Events.subscribe(target, "pointermove", (event: PointerEvent) => {
                    if (event.pointerId === pointerId) {
                        // Accumulate movement deltas into clientX/Y when the pointer is locked
                        if (targetElement !== null && document.pointerLockElement === targetElement) {
                            moveEvent.clientX += event.movementX
                            moveEvent.clientY += event.movementY
                        } else {
                            moveEvent.clientX = event.clientX
                            moveEvent.clientY = event.clientY
                            requestPointerLockIfNeeded(event.clientX, event.clientY)
                        }
                        moveEvent.altKey = event.altKey
                        moveEvent.shiftKey = event.shiftKey
                        moveEvent.ctrlKey = Keyboard.isControlKey(event)
                        process.update(moveEvent)
                    }
                }))
            }
            const cancel = () => {
                if (pointerLockActive && targetElement !== null && document.pointerLockElement === targetElement) {
                    document.exitPointerLock()
                }
                process.cancel?.call(process)
                process.finally?.call(process)
                processCycle.terminate()
            }
            const owner = safeRead(target, "ownerDocument", "defaultView") as WindowProxy ?? self
            processCycle.ownAll(
                Events.subscribe(target, "pointerup", (event: PointerEvent) => {
                    if (event.pointerId === pointerId) {
                        if (pointerLockActive && targetElement !== null && document.pointerLockElement === targetElement) {
                            document.exitPointerLock()
                        }
                        process.approve?.call(process)
                        process.finally?.call(process)
                        processCycle.terminate()
                    }
                }, {capture: true}),
                Events.subscribe(target, "pointercancel", (event: PointerEvent) => {
                    console.debug(event.type)
                    if (event.pointerId === pointerId) {
                        target.releasePointerCapture(pointerId)
                        cancel()
                    }
                }, {capture: true}),
                Events.subscribe(owner, "beforeunload", (_event: BeforeUnloadEvent) => {
                    // Workaround for Chrome (does not release or cancel the pointer)
                    target.releasePointerCapture(pointerId)
                    cancel()
                }, {capture: true}),
                Events.subscribe(owner, "keydown", (event: KeyboardEvent) => {
                    moveEvent.altKey = event.altKey
                    moveEvent.shiftKey = event.shiftKey
                    moveEvent.ctrlKey = Keyboard.isControlKey(event)
                    if (event.key === "Escape") {cancel()} else {process.update(moveEvent)}
                }),
                Events.subscribe(owner, "keyup", (event: KeyboardEvent) => {
                    moveEvent.altKey = event.altKey
                    moveEvent.shiftKey = event.shiftKey
                    moveEvent.ctrlKey = Keyboard.isControlKey(event)
                    process.update(moveEvent)
                })
            )
            if (isDefined(process.abortSignal)) {
                processCycle.own(Events.subscribe(process.abortSignal, "abort", () => {
                    target.releasePointerCapture(pointerId)
                    cancel()
                }))
            }
        }))
    }
}