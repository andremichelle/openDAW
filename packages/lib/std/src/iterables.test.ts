import {describe, expect, it, vi} from "vitest"
import {Iterables} from "./iterables"

describe("Iterables helpers", () => {
    /* ------------------------------------------------------------------
     * trivial generators
     * ------------------------------------------------------------------ */
    it("empty() yields nothing", () => {
        expect(Array.from(Iterables.empty<number>())).toStrictEqual([])
    })

    it("one() yields a single element", () => {
        expect(Array.from(Iterables.one("x"))).toStrictEqual(["x"])
    })

    it("range() yields 0..count-1 with a single argument", () => {
        expect(Array.from(Iterables.range(4))).toStrictEqual([0, 1, 2, 3])
        expect(Array.from(Iterables.range(0))).toStrictEqual([])
    })

    it("range() yields start..end-1 with two arguments", () => {
        expect(Array.from(Iterables.range(2, 5))).toStrictEqual([2, 3, 4])
        expect(Array.from(Iterables.range(5, 5))).toStrictEqual([]) // empty when start >= end
        expect(Array.from(Iterables.range(7, 2))).toStrictEqual([]) // no countdown without a negative step
    })

    it("range() steps by step while staying short of end", () => {
        expect(Array.from(Iterables.range(0, 320, 80))).toStrictEqual([0, 80, 160, 240])
        expect(Array.from(Iterables.range(0, 10, 3))).toStrictEqual([0, 3, 6, 9])
    })

    it("range() counts down with a negative step", () => {
        expect(Array.from(Iterables.range(3, 0, -1))).toStrictEqual([3, 2, 1])
        expect(Array.from(Iterables.range(10, 0, -4))).toStrictEqual([10, 6, 2])
    })

    it("range() yields nothing for a zero step rather than looping forever", () => {
        expect(Array.from(Iterables.range(0, 5, 0))).toStrictEqual([])
    })

    it("range() supports a negative start when an end is given", () => {
        expect(Array.from(Iterables.range(-3, 2))).toStrictEqual([-3, -2, -1, 0, 1])
        expect(Array.from(Iterables.range(-2, 3, 2))).toStrictEqual([-2, 0, 2])
        expect(Array.from(Iterables.range(2, -2, -1))).toStrictEqual([2, 1, 0, -1])
    })

    it("range() rejects a negative count (single argument)", () => {
        expect(() => Array.from(Iterables.range(-1))).toThrow()
        expect(() => Array.from(Iterables.range(-100))).toThrow()
    })

    /* ------------------------------------------------------------------
     * aggregate helpers
     * ------------------------------------------------------------------ */
    it("count() returns length of iterable", () => {
        expect(Iterables.count(Iterables.empty())).toBe(0)
        expect(Iterables.count([1, 2, 3, 4])).toBe(4)
    })

    it("some() / every() behave like Array.prototype.some/every", () => {
        const even = (n: number) => n % 2 === 0

        expect(Iterables.some([1, 3, 5], even)).toBe(false)
        expect(Iterables.some([1, 2, 3], even)).toBe(true)

        // By convention every([]) === true
        expect(Iterables.every([], even)).toBe(true)
        expect(Iterables.every([2, 4, 6], even)).toBe(true)
        expect(Iterables.every([2, 3, 4], even)).toBe(false)
    })

    it("reduce() accumulates with proper indices", () => {
        const indices: number[] = []
        const sum = Iterables.reduce([10, 20, 30], (acc, v, idx) => {
            indices.push(idx)
            return acc + v
        }, 0)
        expect(sum).toBe(60)
        expect(indices).toStrictEqual([0, 1, 2])
    })

    it("includes() performs strict equality search", () => {
        expect(Iterables.includes(["a", "b", "c"], "b")).toBe(true)
        expect(Iterables.includes(["a", "b", "c"], "d")).toBe(false)
    })

    it("forEach() invokes procedure for every item", () => {
        const spy = vi.fn()
        Iterables.forEach([7, 8, 9], spy)
        expect(spy).toHaveBeenCalledTimes(3)
        expect(spy).toHaveBeenNthCalledWith(1, 7)
        expect(spy).toHaveBeenNthCalledWith(2, 8)
        expect(spy).toHaveBeenNthCalledWith(3, 9)
    })

    /* ------------------------------------------------------------------
     * transformation helpers
     * ------------------------------------------------------------------ */
    it("map() yields mapped values with correct indices", () => {
        const result = Array.from(Iterables.map(["x", "y"], (v, i) => `${i}:${v}`))
        expect(result).toStrictEqual(["0:x", "1:y"])
    })

    it("take() yields at most the requested number of elements", () => {
        expect(Array.from(Iterables.take([1, 2, 3, 4], 2))).toStrictEqual([1, 2])
        expect(Array.from(Iterables.take([1, 2], 5))).toStrictEqual([1, 2]) // not enough to fill
    })

    it("filter() keeps only elements that satisfy predicate", () => {
        const even = (n: number) => n % 2 === 0
        expect(Iterables.filter([1, 2, 3, 4, 5], even)).toStrictEqual([2, 4])
    })

    it("filterMap() filters out nullish values after mapping", () => {
        const mapper = (n: number) => (n > 0 ? n * 2 : null)
        expect(Iterables.filterMap([-1, 0, 2, 3], mapper)).toStrictEqual([4, 6])
    })

    it("reverse() returns the iterable in reverse order", () => {
        expect(Array.from(Iterables.reverse([1, 2, 3]))).toStrictEqual([3, 2, 1])
    })

    /* ------------------------------------------------------------------
     * pairWise() – already had basic tests; add one more edge-case
     * ------------------------------------------------------------------ */
    it("pairWise() produces consecutive pairs and last+null", () => {
        expect(Array.from(Iterables.pairWise([]))).toStrictEqual([])
        expect(Array.from(Iterables.pairWise([42]))).toStrictEqual([[42, null]])
        expect(Array.from(Iterables.pairWise([1, 2, 3]))).toStrictEqual([[1, 2], [2, 3], [3, null]])
    })
})