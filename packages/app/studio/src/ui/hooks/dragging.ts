import {Dragging, PointerCaptureTarget} from "@moises-ai/lib-dom"
import {Func, Option, safeExecute, Terminable, unitValue, ValueGuide} from "@moises-ai/lib-std"

export namespace ValueDragging {
    export interface Process {
        start(): unitValue
        modify(value: unitValue): void
        finalise(prevValue: unitValue, newValue: unitValue): void
        cancel(prevValue: unitValue): void
        finally?(): void
        abortSignal?: AbortSignal
    }

    export const installUnitValueRelativeDragging = (factory: Func<PointerEvent, Option<Process>>,
                                                     target: PointerCaptureTarget,
                                                     options?: ValueGuide.Options): Terminable =>
        Dragging.attach(target, (event: PointerEvent) => {
            const optProcess = factory(event)
            if (optProcess.isEmpty()) {return Option.None}
            const horizontal = options?.horizontal === true
            const process = optProcess.unwrap()
            const startValue = process.start()
            const guide = ValueGuide.create(options)
            if (event.shiftKey) {guide.disable()} else {guide.enable()}
            guide.begin(startValue)
            guide.ratio(event.altKey ? 0.25 : options?.ratio ?? 1.5)
            let pointer = horizontal ? event.clientX : -event.clientY
            return Option.wrap({
                abortSignal: process.abortSignal,
                update: (event: Dragging.Event): void => {
                    if (event.shiftKey) {guide.disable()} else {guide.enable()}
                    guide.ratio(event.altKey ? 0.25 : options?.ratio ?? 1.5)
                    const newPointer = horizontal ? event.clientX : -event.clientY
                    guide.moveBy(newPointer - pointer)
                    pointer = newPointer
                    process.modify(guide.value())
                },
                approve: () => process.finalise(startValue, guide.value()),
                cancel: () => process.cancel(startValue),
                finally: () => safeExecute(process.finally)
            })
        }, {pointerLock: true})
}