import {asDefined, Func, int, Nullable, NumberArray, panic, Predicate} from "./lang"

export enum Sorting {Ascending = 1, Descending = -1}

export class Arrays {
    static readonly #empty = Object.freeze(new Array<never>(0))
    static readonly empty = <T>(): ReadonlyArray<T> => (() => this.#empty)()
    static readonly clear = <T>(array: Array<T>): void => {array.length = 0}
    static readonly replace = <T>(array: Array<T>, newValues: Array<T>): void => {
        array.length = 0
        array.push(...newValues)
    }
    static readonly consume = <T>(array: Array<T>, procedure: Func<T, boolean>): void => {
        for (let index = 0; index < array.length;) {
            if (procedure(array[index])) {array.splice(index, 1)} else {index++}
        }
    }
    static readonly peekFirst = <T>(array: ReadonlyArray<T>): Nullable<T> => array.at(0) ?? null
    static readonly peekLast = <T>(array: ReadonlyArray<T>): Nullable<T> => array.at(-1) ?? null
    static readonly getFirst = <T>(array: ReadonlyArray<T>, fail: string): T => asDefined(array.at(0), fail)
    static readonly getLast = <T>(array: ReadonlyArray<T>, fail: string): T => asDefined(array.at(-1), fail)
    static readonly getPrev = <T>(array: Array<T>, element: T): T => {
        const index: int = array.indexOf(element)
        if (index === -1) {return panic(`${element} not found in ${array}`)}
        return asDefined(array.at((index - 1) % array.length), "Internal Error")
    }
    static readonly getNext = <T>(array: Array<T>, element: T): T => {
        const index: int = array.indexOf(element)
        if (index === -1) {return panic(`${element} not found in ${array}`)}
        return asDefined(array.at((index + 1) % array.length), "Internal Error")
    }
    static readonly removeLast = <T>(array: Array<T>, fail: string): T => asDefined(array.pop(), fail)
    static readonly create = <T>(factory: Func<int, T>, n: int): Array<T> => {
        const array: T[] = new Array<T>(n)
        for (let i: int = 0; i < n; i++) {array[i] = factory(i)}
        return array
    }
    static readonly equals = <T>(a: ArrayLike<T>, b: ArrayLike<T>) => {
        if (a.length !== b.length) {return false}
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {return false}
        }
        return true
    }

    /**
     * The satisfy method checks if all elements in a given array satisfy a provided predicate function
     * when compared with the first element of the array. That essentially means that all tested properties
     * in the predicate function are equal throughout the array.
     * [1, 1, 1, 1, 1] > (a, b) => a === b returns true
     * [1, 1, 1, 1, 2] > (a, b) => a === b returns false
     * [1, 1, 3, 2, 1] > (a, b) => a === b returns false
     */
    static readonly satisfy = <T>(array: ReadonlyArray<T>, predicate: (a: T, b: T) => boolean): boolean => {
        if (array.length < 2) {return true}
        const first = array[0]
        for (let i = 1; i < array.length; i++) {
            if (!predicate(first, array[i])) {return false}
        }
        return true
    }
    static readonly remove = <T>(array: Array<T>, element: T): void => {
        const index: int = array.indexOf(element)
        if (index === -1) {return panic(`${element} not found in ${array}`)}
        array.splice(index, 1)
    }
    static readonly removeIf = <T>(array: Array<T>, predicate: Predicate<T>): void => {
        for (let i = array.length - 1; i >= 0; i--) {
            if (predicate(array[i])) {array.splice(i, 1)}
        }
    }
    static readonly removeOpt = <T>(array: Array<T>, element: T): boolean => {
        const index: int = array.indexOf(element)
        if (index === -1) {return false}
        array.splice(index, 1)
        return true
    }
    static readonly hasDuplicates = <T>(array: Array<T>): boolean => new Set<T>(array).size < array.length
    static readonly removeDuplicates = <T>(array: Array<T>): Array<T> => {
        let index = 0 | 0
        const result = new Set<T>()
        for (const element of array) {
            if (!result.has(element)) {
                result.add(element)
                array[index++] = element
            }
        }
        array.length = index
        return array
    }
    static readonly removeDuplicateKeys = <T, K extends keyof T>(array: Array<T>, key: K): Array<T> => {
        let index = 0 | 0
        const seen = new Set<T[K]>()
        for (const element of array) {
            const value = element[key]
            if (!seen.has(value)) {
                seen.add(value)
                array[index++] = element
            }
        }
        array.length = index
        return array
    }
    static subtract<T, U>(array: ReadonlyArray<T>,
                          excludeArray: ReadonlyArray<U>,
                          compareFn: (a: T, b: U) => boolean): Array<T> {
        return array.filter(item => !excludeArray.some(excludeItem => compareFn(item, excludeItem)))
    }
    static intersect<T, U>(array: ReadonlyArray<T>,
                           other: ReadonlyArray<U>,
                           compareFn: (a: T, b: U) => boolean): Array<T> {
        return array.filter(item => other.some(includeItem => compareFn(item, includeItem)))
    }
    static merge<T>(baseArray: ReadonlyArray<T>,
                    mergeIntoArray: ReadonlyArray<T>,
                    compareFn: (a: T, b: T) => boolean): Array<T> {
        return [...(baseArray
            .filter(baseItem => !mergeIntoArray
                .some(mergeItem => compareFn(baseItem, mergeItem)))), ...mergeIntoArray]
    }
    static* iterate<T>(array: ArrayLike<T>): IterableIterator<T> {
        for (let i: int = 0; i < array.length; i++) {
            yield array[i]
        }
    }
    static* iterateReverse<T>(array: ArrayLike<T>): IterableIterator<T> {
        for (let i: int = array.length - 1; i >= 0; i--) {
            yield array[i]
        }
    }
    static* iterateStateFull<T>(array: ArrayLike<T>): IterableIterator<{ value: T, isFirst: boolean, isLast: boolean }> {
        const maxIndex = array.length - 1
        for (let i: int = 0; i <= maxIndex; i++) {
            yield {value: array[i], isFirst: i === 0, isLast: i === maxIndex}
        }
    }
    static* iterateAdjacent<T>(array: ArrayLike<T>): IterableIterator<[T, T]> {
        if (array.length <= 1) {return}
        for (let i = 1, left = array[0]; i < array.length; i++) {
            const right = array[i]
            yield [left, right]
            left = right
        }
    }
    static isSorted<ARRAY extends NumberArray>(array: ARRAY, sorting: Sorting = Sorting.Ascending): boolean {
        if (array.length < 2) {return true}
        let prev: number = array[0]
        for (let i: int = 1; i < array.length; i++) {
            const next: number = array[i]
            if (Math.sign(prev - next) === sorting) {return false}
            prev = next
        }
        return true
    }

    static toRecord<T, U extends keyof any>(array: ReadonlyArray<T>,
                                            toKey: Func<T, U>): Record<U, T> {
        return array.reduce((record, value) => {
            record[toKey(value)] = value
            return record
        }, {} as Record<U, T>)
    }

    static concatArrayBuffers(a: ArrayBufferLike, b: ArrayBufferLike): ArrayBuffer {
        const result = new ArrayBuffer(a.byteLength + b.byteLength)
        const view = new Uint8Array(result)
        view.set(new Uint8Array(a), 0)
        view.set(new Uint8Array(b), a.byteLength)
        return result
    }
}