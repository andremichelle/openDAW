import {
    Arrays,
    BinarySearch,
    Comparator,
    Func,
    IterableIterators,
    int,
    Integer,
    isDefined,
    mod,
    Nullable,
    NumberComparator,
    Option,
    Predicate,
    Predicates,
    unitValue
} from "@opendaw/lib-std"
import {ppqn} from "./ppqn"

export interface Event {
    readonly type: string

    get position(): ppqn
}

export namespace Event {
    export const Comparator: Comparator<Event> = (a: Event, b: Event) => a.position - b.position

    export const PositionExtractor: Func<Event, ppqn> = (event: Event) => event.position
}

export interface EventSpan extends Event {
    get duration(): ppqn
}

export namespace EventSpan {
    export const complete = (event: EventSpan): ppqn => event.position + event.duration

    export const DescendingComparator: Comparator<EventSpan> = (a: EventSpan, b: EventSpan) => complete(b) - complete(a)
}

export type Region = EventSpan

export interface LoopableRegion extends Region {
    get loopOffset(): ppqn
    get loopDuration(): ppqn
}

// https://www.desmos.com/calculator/xz4tl5a9o9
export namespace LoopableRegion {
    export const globalToLocal = (region: LoopableRegion, ppqn: ppqn): ppqn =>
        mod(ppqn - region.position + region.loopOffset, region.loopDuration)

    export interface LoopCycle {
        // index of the cycle
        index: int
        // Full raw loop cycle, independent of region and search bounds
        rawStart: ppqn
        rawEnd: ppqn
        // Loop cycle clipped to fit within the defined region
        regionStart: ppqn
        regionEnd: ppqn
        // Loop cycle clipped to the result space based on the search range
        resultStart: ppqn
        resultEnd: ppqn
        // Ratio indicating the start point within the result space (0 = full, >0 = clipped at the start)
        // Ratio indicating the end point within the result space (1 = full, <1 = clipped at the end)
        resultStartValue: unitValue
        resultEndValue: unitValue
    }

    export type Region = { position: ppqn, complete: ppqn, loopOffset: ppqn, loopDuration: ppqn }

    // This locates the first loop iteration and returns a LoopPass, if the loop overlaps the passed range
    // It is probably only used in region editors to render the region's content with the same renderer.
    export const locateLoop = ({position, complete, loopOffset, loopDuration}: Region,
                               from: ppqn,
                               to: ppqn): Option<LoopCycle> => {
        const rawStart = position - loopOffset
        const rawEnd = rawStart + loopDuration
        if (rawStart >= to || rawEnd <= from) {return Option.None} // no overlap
        const resultStart = Math.max(rawStart, from)
        const resultEnd = Math.min(rawEnd, to)
        return Option.wrap({
            index: 0,
            rawStart,
            rawEnd,
            regionStart: Math.max(rawStart, position),
            regionEnd: Math.min(rawEnd, complete),
            resultStart,
            resultEnd,
            resultStartValue: rawStart < resultStart ? (resultStart - rawStart) / loopDuration : 0.0,
            resultEndValue: rawEnd > resultEnd ? (resultEnd - rawStart) / loopDuration : 1.0
        } satisfies LoopCycle)
    }

    // This locates all loop passes within a given range.
    // This is used for region rendering but can also be used for sequencing region's content.
    export function* locateLoops({position, complete, loopOffset, loopDuration}: Region,
                                 from: ppqn,
                                 to: ppqn): IterableIterator<LoopCycle> {
        const offset = position - loopOffset
        const seekMin = Math.max(position, from)
        const seekMax = Math.min(complete, to)
        let passIndex = Math.floor((seekMin - offset) / loopDuration)
        let rawStart: ppqn = offset + passIndex * loopDuration
        while (rawStart < seekMax) {
            const rawEnd = rawStart + loopDuration
            const regionStart = Math.max(rawStart, position)
            const regionEnd = Math.min(rawEnd, complete)
            const resultStart = Math.max(rawStart, seekMin)
            const resultEnd = Math.min(rawEnd, seekMax)
            const resultStartValue: unitValue = rawStart < resultStart ? (resultStart - rawStart) / loopDuration : 0.0
            const resultEndValue: unitValue = rawEnd > resultEnd ? (resultEnd - rawStart) / loopDuration : 1.0
            yield {
                index: passIndex++,
                rawStart,
                rawEnd,
                regionStart,
                regionEnd,
                resultStart,
                resultEnd,
                resultStartValue,
                resultEndValue
            }
            rawStart = rawEnd
        }
    }
}

export interface Track<REGION extends EventSpan> {
    get regions(): EventArray<REGION>
    get enabled(): boolean
    get index(): int
}

export class EventCollection<EVENT extends Event = Event> implements EventArray<EVENT> {
    static DefaultComparator: Comparator<Event> = (a: Event, b: Event): int => a.position - b.position

    static create<EVENT extends Event>(comparator?: Comparator<EVENT>): EventCollection<EVENT> {
        return new EventCollection<EVENT>(comparator ?? EventCollection.DefaultComparator)
    }

    readonly #array: EventArrayImpl<EVENT>

    private constructor(comparator: Comparator<EVENT>) {this.#array = new EventArrayImpl<EVENT>(comparator)}

    add(event: EVENT): void {this.#array.add(event)}
    remove(event: EVENT): boolean {return this.#array.remove(event)}
    contains(event: EVENT): boolean {return this.#array.contains(event)}
    clear(): void {this.#array.clear()}
    optAt(index: number): Nullable<EVENT> {return this.#array.optAt(index)}
    asArray(): ReadonlyArray<EVENT> {return this.#array.asArray()}
    lowerEqual(position: number, predicate?: Predicate<EVENT>): Nullable<EVENT> {
        return this.#array.lowerEqual(position, predicate)
    }
    greaterEqual(position: number, predicate?: Predicate<EVENT>): Nullable<EVENT> {
        return this.#array.greaterEqual(position, predicate)
    }
    floorLastIndex(position: number): number {return this.#array.floorLastIndex(position)}
    ceilFirstIndex(position: number): number {return this.#array.ceilFirstIndex(position)}

    /**
     * Iterate over all events starting from the given position.
     * If an event starts on or before(!) the given position, it will be included.
     */
    iterateFrom(fromPosition: number, predicate?: Predicate<EVENT>): IterableIterator<EVENT> {
        if (this.#array.isEmpty()) {return IterableIterators.empty()}
        return this.#array.iterateFrom(fromPosition, predicate)
    }
    iterateRange(fromPosition: int, toPosition: int, predicate?: Predicate<EVENT>): IterableIterator<EVENT> {
        if (this.#array.isEmpty()) {return IterableIterators.empty()}
        return this.#array.iterate(this.#array.ceilFirstIndex(fromPosition), toPosition, predicate)
    }
    first(): Nullable<EVENT> {return this.#array.optAt(0)}
    last(): Nullable<EVENT> {return this.#array.optAt(this.#array.length() - 1)}
    length(): number {return this.#array.length()}
    isEmpty(): boolean {return this.#array.isEmpty()}
    onIndexingChanged(): void {this.#array.onIndexingChanged()}
}

export class RegionCollection<REGION extends EventSpan> implements EventArray<REGION> {
    static Comparator: Comparator<EventSpan> = (a: EventSpan, b: EventSpan): int => a.position - b.position

    static create<REGION extends EventSpan>(comparator: Comparator<REGION>): RegionCollection<REGION> {
        return new RegionCollection<REGION>(comparator)
    }

    readonly #array: EventArrayImpl<REGION>

    private constructor(comparator: Comparator<REGION> = RegionCollection.Comparator) {
        this.#array = new EventArrayImpl<REGION>(comparator)
    }

    add(event: REGION): void {this.#array.add(event)}
    remove(event: REGION): boolean {return this.#array.remove(event)}
    contains(event: REGION): boolean {return this.#array.contains(event)}
    clear(): void {this.#array.clear()}
    optAt(index: number): Nullable<REGION> {return this.#array.optAt(index)}
    asArray(): ReadonlyArray<REGION> {return this.#array.asArray()}
    lowerEqual(position: number, predicate?: Predicate<REGION>): Nullable<REGION> {
        return this.#array.lowerEqual(position, predicate)
    }
    greaterEqual(position: number, predicate?: Predicate<REGION>): Nullable<REGION> {
        return this.#array.greaterEqual(position, predicate)
    }
    floorLastIndex(position: number): number {return this.#array.floorLastIndex(position)}
    ceilFirstIndex(position: number): number {return this.#array.ceilFirstIndex(position)}
    iterateFrom(fromPosition: number, predicate?: Predicate<REGION>): IterableIterator<REGION> {
        return this.#array.isEmpty() ? IterableIterators.empty() : this.#array.iterateFrom(fromPosition, predicate)
    }
    iterateRange(fromPosition: int, toPosition: int): IterableIterator<REGION> {
        if (this.#array.isEmpty()) {return IterableIterators.empty()}
        let index: int = Math.max(0, this.#array.floorLastIndex(fromPosition))
        let period: Nullable<REGION> = this.#array.optAt(index)
        if (period === null) {return IterableIterators.empty()}
        while (period.position + period.duration <= fromPosition) {
            period = this.#array.optAt(++index)
            if (period === null || period.position >= toPosition) {
                return IterableIterators.empty()
            }
        }
        return this.#array.iterate(index, toPosition)
    }
    length(): number {return this.#array.length()}
    isEmpty(): boolean {return this.#array.isEmpty()}
    onIndexingChanged(): void {this.#array.onIndexingChanged()}
}

export interface EventArray<E extends Event> {
    add(event: E): void
    remove(event: E): boolean
    contains(event: E): boolean
    clear(): void
    optAt(index: int): Nullable<E>
    asArray(): ReadonlyArray<E>
    lowerEqual(position: int, predicate?: Predicate<E>): Nullable<E>
    greaterEqual(position: int): Nullable<E>
    floorLastIndex(position: int): int
    ceilFirstIndex(position: int): int
    iterateFrom(fromPosition: int, predicate?: Predicate<E>): IterableIterator<E>
    iterateRange(fromPosition: int, toPosition: int, predicate?: Predicate<E>): IterableIterator<E>
    length(): int
    isEmpty(): boolean
    onIndexingChanged(): void
}

export class EventSpanRetainer<E extends EventSpan> {
    readonly #array: Array<E>

    constructor() {this.#array = []}

    addAndRetain(event: E): void {
        if (this.#array.length === 0) {
            this.#array.push(event)
        } else {
            const insertIndex: int = BinarySearch.leftMost(this.#array, event, EventSpan.DescendingComparator)
            this.#array.splice(insertIndex, 0, event)
        }
    }

    * overlapping(position: ppqn, comparator?: Comparator<E>): IterableIterator<E> {
        const result = this.#array.filter(event => event.position <= position && position < event.position + event.duration)
        yield* isDefined(comparator) ? result.sort(comparator) : result
    }

    * releaseLinearCompleted(position: ppqn): IterableIterator<E> {
        if (this.#array.length === 0) {return}
        for (let lastIndex = this.#array.length - 1; lastIndex >= 0; lastIndex--) {
            const event = this.#array[lastIndex]
            if (EventSpan.complete(event) < position) {
                this.#array.splice(lastIndex, 1)
                yield event
            } else {
                return
            }
        }
    }

    * release(predicate: Predicate<E>): IterableIterator<E> {
        if (this.#array.length === 0) {return}
        for (let lastIndex = this.#array.length - 1; lastIndex >= 0; lastIndex--) {
            const event = this.#array[lastIndex]
            if (predicate(event)) {
                this.#array.splice(lastIndex, 1)
                yield event
            }
        }
    }

    * releaseAll(): IterableIterator<E> {
        if (this.#array.length === 0) {return}
        for (let lastIndex = this.#array.length - 1; lastIndex >= 0; lastIndex--) {
            const event = this.#array[lastIndex]
            if (Number.POSITIVE_INFINITY > event.duration) {
                this.#array.splice(lastIndex, 1)
                yield event
            }
        }
    }

    isEmpty(): boolean {return this.#array.length === 0}
    nonEmpty(): boolean {return this.#array.length > 0}

    clear(): void {Arrays.clear(this.#array)}
}

class EventArrayImpl<E extends Event> implements Omit<EventArray<E>, "iterateRange"> {
    readonly #array: Array<E> = []

    #unsorted: boolean = false
    modCount: int = 0

    constructor(private readonly comparator: Comparator<E>) {}

    add(event: E): void {
        ++this.modCount
        this.#array.push(event)
        if (this.#array.length > 1) {
            this.#unsorted = true
        }
    }

    remove(event: E): boolean {
        ++this.modCount
        const index = this.#array.indexOf(event)
        if (-1 === index) {return false}
        this.#array.splice(index, 1)
        return true
    }

    contains(event: E): boolean {
        const size: int = this.#array.length
        if (size === 0) {return false}
        if (this.#unsorted) {this.#sort()}
        const key: int = event.position
        const startIndex: int = BinarySearch.leftMostMapped(this.#array, key, NumberComparator, Event.PositionExtractor)
        for (let i: int = startIndex; i < this.#array.length; i++) {
            const other: E = this.#array[i]
            if (other === event) {return true}
            if (other.position !== key) {return false}
        }
        return false
    }

    clear(): void {
        ++this.modCount
        Arrays.clear(this.#array)
        this.#unsorted = false
    }

    optAt(index: int): Nullable<E> {
        if (index < 0 || index >= this.#array.length) {return null}
        if (this.#unsorted) {this.#sort()}
        return this.#array[index]
    }

    asArray(): ReadonlyArray<E> {
        if (this.#unsorted) {this.#sort()}
        return this.#array
    }

    lowerEqual(position: int, predicate?: Predicate<E>): Nullable<E> {
        if (predicate === undefined) {return this.optAt(this.floorLastIndex(position))}
        let index: int = this.floorLastIndex(position)
        while (index >= 0) {
            const event: E = this.#array[index--]
            if (predicate(event)) {return event}
        }
        return null
    }

    greaterEqual(position: int, predicate?: Predicate<E>): Nullable<E> {
        if (predicate === undefined) {return this.optAt(this.ceilFirstIndex(position))}
        let index: int = this.ceilFirstIndex(position)
        while (index < this.#array.length) {
            const event: E = this.#array[index++]
            if (predicate(event)) {return event}
        }
        return null
    }

    floorLastIndex(position: int): int {
        if (this.#unsorted) {this.#sort()}
        return BinarySearch.rightMostMapped(this.#array, position, NumberComparator, Event.PositionExtractor)
    }

    ceilFirstIndex(position: int): int {
        if (this.#unsorted) {this.#sort()}
        return BinarySearch.leftMostMapped(this.#array, position, NumberComparator, Event.PositionExtractor)
    }

    iterateFrom(fromPosition: int, predicate?: Predicate<E>): IterableIterator<E> {
        const floorLastIndex: int = this.floorLastIndex(fromPosition)
        let startIndex: int = floorLastIndex
        if (startIndex < 0) {
            return this.iterate(0, Integer.MAX_VALUE, predicate)
        }
        while (startIndex >= 0) {
            const event: Nullable<E> = this.optAt(startIndex)
            if (event !== null && predicate !== undefined && predicate(event)) {
                return this.iterate(startIndex, Integer.MAX_VALUE, predicate)
            }
            startIndex--
        }
        return this.iterate(floorLastIndex, Integer.MAX_VALUE, predicate)
    }

    length(): int {return this.#array.length}
    isEmpty(): boolean {return this.#array.length === 0}
    onIndexingChanged(): void {this.#unsorted = this.length() > 1}

    * iterate(fromIndex: int, toPosition: int, predicate: Predicate<E> = Predicates.alwaysTrue): IterableIterator<E> {
        if (this.#unsorted) {this.#sort()}
        while (fromIndex < this.#array.length) {
            const element = this.#array[fromIndex++]
            if (element.position >= toPosition) {return}
            if (predicate(element)) {yield element}
        }
    }

    #sort(): void {
        this.#array.sort(this.comparator)
        this.#unsorted = false
    }
}