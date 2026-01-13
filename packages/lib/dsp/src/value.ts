import {BinarySearch, Comparator, Curve, int, Iterables, Nullable, panic, unitValue} from "@moises-ai/lib-std"
import {Event, EventCollection} from "./events"
import {ppqn} from "./ppqn"

export type Interpolation = | { type: "none" } | { type: "linear" } | { type: "curve", slope: unitValue }

export const Interpolation = {
    None: {type: "none"} as const,
    Linear: {type: "linear"} as const,
    Curve: (slope: unitValue) => slope === 0.5 ? Interpolation.Linear : ({type: "curve", slope}) as const
} as const

export interface ValueEvent extends Event {
    readonly type: "value-event"

    get index(): int
    get value(): number
    get interpolation(): Interpolation
}

export namespace ValueEvent {
    export const Comparator: Comparator<ValueEvent> = (a: ValueEvent, b: ValueEvent) => {
        const positionDiff = a.position - b.position
        if (positionDiff !== 0) {return positionDiff}
        const indexDiff = a.index - b.index
        if (indexDiff !== 0) {return indexDiff}
        return a === b ? 0 : panic(`${a} and ${b} are identical in terms of comparison`)
    }

    export function* iterateWindow<E extends ValueEvent>(events: EventCollection<E>,
                                                         fromPosition: ppqn,
                                                         toPosition: ppqn): IterableIterator<E> {
        if (events.isEmpty()) {return Iterables.empty()}
        for (const event of events.iterateFrom(fromPosition)) {
            yield event
            if (event.position >= toPosition) {return}
        }
    }

    export const nextEvent = <E extends ValueEvent>(events: EventCollection<E>, precursor: E): Nullable<E> => {
        const sorted = events.asArray()
        const index = BinarySearch.rightMost(sorted, precursor, ValueEvent.Comparator)
        return index === -1 ? null : sorted[index + 1] ?? null
    }

    /**
     * Computes a value at a given position
     */
    export const valueAt = <E extends ValueEvent>(events: EventCollection<E>,
                                                  position: ppqn,
                                                  fallback: number): number => {
        if (events.isEmpty()) {return fallback} // no events, nothing to iterate
        const iterator = events.iterateFrom(position)
        const {done, value: prevEvent} = iterator.next()
        if (done) {return fallback}
        if (prevEvent.position <= position) {
            const {done, value: nextEvent} = iterator.next()
            if (done) {
                return prevEvent.value
            } else if (position < nextEvent.position) {
                return interpolate(prevEvent, nextEvent, position)
            } else if (prevEvent.interpolation === Interpolation.None) {
                return prevEvent.value
            }
        }
        return prevEvent.value
    }

    /**
     * Quantize an automation in equal segments but also include min/max values.
     * This is used for the ValueClipPainter to draw circular automation curves.
     * It has been tested in the AutomationPage.
     */
    export function* quantise<E extends ValueEvent>(events: EventCollection<E>,
                                                    position: ppqn,
                                                    duration: ppqn,
                                                    numSteps: number): IterableIterator<{
        position: ppqn,
        value: number
    }> {
        if (events.isEmpty()) {return} // no events, nothing to iterate
        const iterator = events.iterateFrom(position)
        const {done, value} = iterator.next()
        if (done) {return}
        const step: number = duration / numSteps
        let prevEvent = value
        if (prevEvent.position > position) {
            while (position < prevEvent.position) {
                yield {position, value: prevEvent.value}
                position += step
                if (position > duration) {return}
            }
            if (prevEvent.position <= duration) {yield prevEvent}
        }
        while (position <= duration) {
            const {done, value: nextEvent} = iterator.next()
            if (done) {break}
            while (position < nextEvent.position) {
                if (position > duration) {return}
                yield {position, value: interpolate(prevEvent, nextEvent, position)}
                position += step
            }
            if (nextEvent.position < duration) {
                if (prevEvent.interpolation === Interpolation.None) {
                    yield {position: nextEvent.position, value: prevEvent.value}
                }
                yield nextEvent
            }
            prevEvent = nextEvent
        }
        while (position <= duration) {
            yield {position, value: prevEvent.value}
            position += step
        }
    }

    const interpolate = ({value, position, interpolation}: ValueEvent, b: ValueEvent, x: number): number => {
        if (interpolation.type === "none") {
            return value
        } else if (interpolation.type === "linear") {
            return value + (x - position) / (b.position - position) * (b.value - value)
        } else if (interpolation.type === "curve") {
            return Curve.valueAt({
                slope: interpolation.slope,
                steps: b.position - position,
                y0: value,
                y1: b.value
            }, x - position)
        } else {
            return panic("Unknown interpolation")
        }
    }
}