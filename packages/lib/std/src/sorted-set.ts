import {
    asDefined,
    Comparator,
    Func,
    int,
    isDefined,
    Maybe,
    Nullable,
    panic,
    Predicate,
    Procedure,
    Provider
} from "./lang"
import {Arrays} from "./arrays"
import {Option} from "./option"
import {BinarySearch} from "./binary-search"

/**
 * SortedSet
 * ---------------------------
 * Advantages Over Native Set
 * ---------------------------
 * Custom Key Extraction: Allows using complex keys (like UUID) with custom comparison logic
 * Ordered Iteration: Elements are always iterated in sorted order (not necessarily favored)
 * Efficient Lookups: O(log n) lookups using binary search
 * Flexible Duplicate Handling: Control whether to replace or duplicates or throw an error
 * -----------------------------
 * Disadvantages Over Native Set
 * -----------------------------
 * No Range Operations: No efficient range-based operations
 * Losing insert order: Elements get sorted by key and not insert order
 */
export class SortedSet<K, V> implements Iterable<V> {
    readonly #extractor: Func<V, K>
    readonly #comparator: Comparator<K>
    readonly #array: Array<V>

    constructor(extractor: Func<V, K>, comparator: Comparator<K>) {
        this.#extractor = extractor
        this.#comparator = comparator
        this.#array = []
    }

    add(value: V, replace: boolean = false): boolean {
        const key: K = this.#extractor(value)
        const insertIndex: int = BinarySearch.leftMostMapped(this.#array, key, this.#comparator, this.#extractor)
        const current: Maybe<V> = this.#array[insertIndex]
        if (isDefined(current) && this.#comparator(this.#extractor(current), key) === 0) {
            if (replace) {
                this.#array.splice(insertIndex, 1, value)
                return true
            }
            return false
        }
        this.#array.splice(insertIndex, 0, value)
        return true
    }

    getOrCreate(key: K, factory: (key: K) => V): V {
        const insertIndex: int = BinarySearch.leftMostMapped(this.#array, key, this.#comparator, this.#extractor)
        const current: Maybe<V> = this.#array[insertIndex]
        if (isDefined(current) && this.#comparator(this.#extractor(current), key) === 0) {
            return current
        }
        const value = factory(key)
        this.#array.splice(insertIndex, 0, value)
        return value
    }

    addMany(values: Iterable<V>): boolean {
        for (const value of values) {this.#array.push(value)}
        try {
            this.#array.sort((a: V, b: V) => {
                const delta: int = this.#comparator(this.#extractor(a), this.#extractor(b))
                if (delta === 0) {throw "cancel"}
                return delta
            })
            return true
        } catch (reason: any) {
            if (reason === "cancel") {
                const uniqueKeys: Map<K, V> = new Map<K, V>(this.entries())
                this.#array.splice(0, this.#array.length, ...uniqueKeys.values())
                this.#array.sort((a: V, b: V) => this.#comparator(this.#extractor(a), this.#extractor(b)))
                return false
            }
            return panic(reason)
        }
    }

    removeByValue(value: V): V {return this.removeByKey(this.#extractor(value))}

    removeByKey(key: K): V {
        const deleteIndex = BinarySearch.leftMostMapped(this.#array, key, this.#comparator, this.#extractor)
        const candidate: Maybe<V> = this.#array[deleteIndex]
        if (isDefined(candidate) && this.#comparator(this.#extractor(candidate), key) === 0) {
            this.#array.splice(deleteIndex, 1)
            return candidate
        }
        return panic(`Could not remove ${key}`)
    }

    removeByKeyIfExist(key: K): Nullable<V> {
        const deleteIndex = BinarySearch.leftMostMapped(this.#array, key, this.#comparator, this.#extractor)
        const candidate: Maybe<V> = this.#array[deleteIndex]
        if (isDefined(candidate) && this.#comparator(this.#extractor(candidate), key) === 0) {
            this.#array.splice(deleteIndex, 1)
            return candidate
        }
        return null
    }

    removeRange(startIndex: int, endIndex?: int): void {
        this.#array.splice(startIndex, (endIndex ?? this.#array.length) - startIndex)
    }

    removeByPredicate(predicate: Predicate<V>): int {
        let count: int = 0 | 0
        let index: int = this.#array.length
        while (--index >= 0) {
            if (predicate(this.#array[index])) {
                this.#array.splice(index, 1)
                count++
            }
        }
        return count
    }

    get(key: K, fail?: string): V {return asDefined(this.#lookup(key), fail ?? `Unknown key: ${key}`)}

    getOrThrow(key: K, provider: Provider<Error>): V {
        const candidate: Maybe<V> = this.#lookup(key)
        if (isDefined(candidate)) {return candidate} else {throw provider()}
    }

    opt(key: K): Option<V> {return Option.wrap(this.#lookup(key))}
    getOrNull(key: K): Nullable<V> {return this.#lookup(key) ?? null}
    getByIndex(index: int): V {return this.#array[index]}
    hasKey(key: K): boolean {return isDefined(this.#lookup(key))}
    hasValue(value: V): boolean {return isDefined(this.#lookup(this.#extractor(value)))}
    size(): int {return this.#array.length}
    isEmpty(): boolean {return this.#array.length === 0}
    forEach(procedure: Procedure<V>): void {this.values().forEach(procedure)}
    values(): ReadonlyArray<V> {return this.#array}
    entries(): Iterable<[K, V]> {return this.#array.map<[K, V]>((entry: V) => [this.#extractor(entry), entry])}
    clear(): void {Arrays.clear(this.#array)}
    [Symbol.iterator](): Iterator<V> {return this.#array.values()}
    #lookup(key: K): Maybe<V> {
        const index = BinarySearch.leftMostMapped(this.#array, key, this.#comparator, this.#extractor)
        const candidate: Maybe<V> = this.#array[index]
        return isDefined(candidate) && this.#comparator(this.#extractor(candidate), key) === 0 ? candidate : undefined
    }
}