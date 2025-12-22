import {Func, int, isDefined, Maybe, Nullable, Predicate, Procedure} from "./lang"

export class Iterables {
    static* empty<T>(): Iterable<T> {}

    static one<T>(value: T): Iterable<T> { return [value] }

    static count<T>(iterable: Iterable<T>): int {
        let count: int = 0 | 0
        for (const _ of iterable) {count++}
        return count
    }

    static some<T>(iterable: Iterable<T>, predicate: (value: T) => boolean): boolean {
        for (const value of iterable) {
            if (predicate(value)) {return true}
        }
        return false
    }

    static every<T>(iterable: Iterable<T>, predicate: (value: T) => boolean): boolean {
        for (const value of iterable) {
            if (!predicate(value)) {return false}
        }
        return true
    }

    static reduce<T, U>(iterable: Iterable<T>,
                        callback: (previous: U, value: T, index: int) => U, initialValue: U): U {
        let accumulator = initialValue
        let index: int = 0
        for (const value of iterable) {accumulator = callback(accumulator, value, index++)}
        return accumulator
    }

    static includes<T>(iterable: Iterable<T>, include: T): boolean {
        for (const value of iterable) {if (value === include) {return true}}
        return false
    }

    static forEach<T>(iterable: Iterable<T>, procedure: Procedure<T>): void {
        for (const value of iterable) {procedure(value)}
    }

    static* map<T, U>(iterable: Iterable<T>, map: (value: T, index: int) => U): IterableIterator<U> {
        let count = 0 | 0
        for (const value of iterable) {
            yield map(value, count++)
        }
    }

    static* take<T>(iterator: Iterable<T>, count: int): IterableIterator<T> {
        let i = 0
        for (const value of iterator) {
            if (i++ >= count) {return}
            yield value
        }
    }

    static filter<T>(iterable: Iterable<T>, fn: Predicate<T>): T[] {
        const result: Array<T> = []
        for (const value of iterable) {if (fn(value)) {result.push(value)}}
        return result
    }

    static filterMap<T, U>(iterable: Iterable<T>, fn: Func<T, Maybe<U>>): U[] {
        const result: Array<U> = []
        for (const value of iterable) {
            const mapped: Maybe<U> = fn(value)
            if (isDefined(mapped)) {result.push(mapped)}
        }
        return result
    }

    static reverse<T>(iterable: Iterable<T>): Iterable<T> {
        const result: T[] = []
        for (const value of iterable) {result.push(value)}
        return result.reverse()
    }

    static* pairWise<T>(iterable: Iterable<T>): IterableIterator<[T, Nullable<T>]> {
        const iterator: Iterator<T> = iterable[Symbol.iterator]()
        const {done, value} = iterator.next()
        let prev: T = value
        if (done === true) {return}
        while (true) {
            const {done, value} = iterator.next()
            if (done === true) {
                yield [prev, null]
                return
            }
            yield [prev, value]
            prev = value
        }
    }
}