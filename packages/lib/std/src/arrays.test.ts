import {describe, expect, it} from "vitest"
import {Arrays, Sorting} from "./arrays"

describe("Arrays", () => {
    /* ------------------------------------------------------------------ *
     * empty()
     * ------------------------------------------------------------------ */
    describe("empty()", () => {
        it("should return the same frozen instance every time", () => {
            const first = Arrays.empty<number>()
            const second = Arrays.empty<number>()
            expect(first).toBe(second)                           // same reference
            expect(Object.isFrozen(first)).toBe(true)            // frozen
            expect(first.length).toBe(0)                         // always empty
        })

        it("should throw when an attempt is made to mutate it", () => {
            const empty = Arrays.empty<number>() as number[]
            expect(() => empty.push(1)).toThrow(TypeError)
            expect(empty.length).toBe(0)
        })
    })

    /* ------------------------------------------------------------------ *
     * clear()
     * ------------------------------------------------------------------ */
    describe("clear()", () => {
        it("should remove all elements from a non-empty array", () => {
            const a = [1, 2, 3]
            Arrays.clear(a)
            expect(a).toStrictEqual([])
        })

        it("should leave an already empty array untouched", () => {
            const a: number[] = []
            Arrays.clear(a)
            expect(a).toStrictEqual([])
        })
    })

    /* ------------------------------------------------------------------ *
     * replace()
     * ------------------------------------------------------------------ */
    describe("replace()", () => {
        it("should replace the whole content independent of length", () => {
            const target = [0, 0, 0, 0]
            Arrays.replace(target, [1, 2])
            expect(target).toStrictEqual([1, 2])

            Arrays.replace(target, [9, 8, 7, 6, 5])
            expect(target).toStrictEqual([9, 8, 7, 6, 5])
        })

        it("should work with an empty source array", () => {
            const target = [1, 2, 3]
            Arrays.replace(target, [])
            expect(target).toStrictEqual([])
        })
    })

    /* ------------------------------------------------------------------ *
     * consume()
     * ------------------------------------------------------------------ */
    describe("consume()", () => {
        it("should remove elements for which the predicate returns true", () => {
            const data = [1, 2, 3, 4, 5, 6]
            Arrays.consume(data, (v) => v % 2 === 0)   // remove even numbers
            expect(data).toStrictEqual([1, 3, 5])
        })

        it("should keep elements when the predicate always returns false", () => {
            const data = [1, 2, 3]
            Arrays.consume(data, () => false)
            expect(data).toStrictEqual([1, 2, 3])
        })
    })

    /* ------------------------------------------------------------------ *
     * peek / get / remove helpers
     * ------------------------------------------------------------------ */
    describe("peekFirst / peekLast", () => {
        it("should return null on an empty array", () => {
            expect(Arrays.peekFirst([])).toBeNull()
            expect(Arrays.peekLast([])).toBeNull()
        })

        it("should return first / last element otherwise", () => {
            const a = [10, 20, 30]
            expect(Arrays.peekFirst(a)).toBe(10)
            expect(Arrays.peekLast(a)).toBe(30)
        })
    })

    describe("getFirst / getLast", () => {
        it("should return the expected element", () => {
            const a = ["x", "y"]
            expect(Arrays.getFirst(a, "fail")).toBe("x")
            expect(Arrays.getLast(a, "fail")).toBe("y")
        })

        it("should throw with the supplied message on empty array", () => {
            expect(() => Arrays.getFirst([], "empty")).toThrow("empty")
            expect(() => Arrays.getLast([], "empty")).toThrow("empty")
        })
    })

    describe("removeLast()", () => {
        it("should pop the last element and return it", () => {
            const a = [1, 2, 3]
            const last = Arrays.removeLast(a, "fail")
            expect(last).toBe(3)
            expect(a).toStrictEqual([1, 2])
        })

        it("should throw when the array is empty", () => {
            expect(() => Arrays.removeLast([], "empty")).toThrow("empty")
        })
    })

    /* ------------------------------------------------------------------ *
     * create()
     * ------------------------------------------------------------------ */
    describe("create()", () => {
        it("should create an array of the requested size using the factory", () => {
            const result = Arrays.create((i) => i * 2, 5)
            expect(result).toStrictEqual([0, 2, 4, 6, 8])
        })

        it("should return an empty array when n = 0", () => {
            expect(Arrays.create(() => 42, 0)).toStrictEqual([])
        })
    })

    /* ------------------------------------------------------------------ *
     * equals()
     * ------------------------------------------------------------------ */
    describe("equals()", () => {
        it("should return true for two arrays with identical content", () => {
            expect(Arrays.equals([1, 2, 3], [1, 2, 3])).toBe(true)
        })

        it("should return false for arrays of different length", () => {
            expect(Arrays.equals([1], [1, 2])).toBe(false)
        })

        it("should return false for arrays with different items", () => {
            expect(Arrays.equals([1, 2, 3], [3, 2, 1])).toBe(false)
        })
    })

    /* ------------------------------------------------------------------ *
     * remove() / removeOpt()
     * ------------------------------------------------------------------ */
    describe("remove() / removeOpt()", () => {
        it("remove() should delete the element or throw if absent", () => {
            const a = [1, 2, 3]
            Arrays.remove(a, 2)
            expect(a).toStrictEqual([1, 3])

            expect(() => Arrays.remove(a, 4)).toThrow()
        })

        it("removeOpt() should return a boolean instead of throwing", () => {
            const a = [1, 2, 3]
            expect(Arrays.removeOpt(a, 2)).toBe(true)
            expect(a).toStrictEqual([1, 3])

            expect(Arrays.removeOpt(a, 4)).toBe(false)
            expect(a).toStrictEqual([1, 3])
        })
    })

    /* ------------------------------------------------------------------ *
     * hasDuplicates / removeDuplicates / removeDuplicateKeys
     * ------------------------------------------------------------------ */
    describe("duplicate helpers", () => {
        it("hasDuplicates() should detect duplicated items", () => {
            expect(Arrays.hasDuplicates([1, 1, 2])).toBe(true)
            expect(Arrays.hasDuplicates([1, 2, 3])).toBe(false)
        })

        it("removeDuplicates() should mutate the array and keep first occurrence", () => {
            const a = [1, 2, 1, 3, 2]
            Arrays.removeDuplicates(a)
            expect(a).toStrictEqual([1, 2, 3])
        })

        it("removeDuplicateKeys() should use the provided key", () => {
            const data = [
                {id: 1, value: "a"},
                {id: 2, value: "b"},
                {id: 1, value: "c"} // duplicate id
            ]
            Arrays.removeDuplicateKeys(data, "id")
            expect(data).toStrictEqual([
                {id: 1, value: "a"},
                {id: 2, value: "b"}
            ])
        })
    })

    /* ------------------------------------------------------------------ *
     * iterate() / iterateReverse()
     * ------------------------------------------------------------------ */
    describe("iterate()", () => {
        it("should yield items in forward order", () => {
            const result = Array.from(Arrays.iterate([1, 2, 3]))
            expect(result).toStrictEqual([1, 2, 3])
        })
    })

    describe("iterateReverse()", () => {
        it("should yield items in reverse order", () => {
            const result = Array.from(Arrays.iterateReverse([1, 2, 3]))
            expect(result).toStrictEqual([3, 2, 1])
        })
    })

    /* ------------------------------------------------------------------ *
     * iterateStateFull()
     * ------------------------------------------------------------------ */
    describe("iterateStateFull()", () => {
        it("should yield metadata about first / last elements", () => {
            const data = [10, 20, 30]
            const result = Array.from(Arrays.iterateStateFull(data))

            expect(result[0]).toStrictEqual({value: 10, isFirst: true, isLast: false})
            expect(result[1]).toStrictEqual({value: 20, isFirst: false, isLast: false})
            expect(result[2]).toStrictEqual({value: 30, isFirst: false, isLast: true})
        })
    })

    describe("iterateAdjacent()", () => {
        it("should yield nothing", () => {
            const data = [10]
            const result = Array.from(Arrays.iterateAdjacent(data))
            expect(result.length).toBe(0)
        })
        it("should yield exact array", () => {
            const data = [10, 20]
            const result = Array.from(Arrays.iterateAdjacent(data))
            expect(result[0]).toStrictEqual([10, 20])
        })
        it("should yield all elements pairwise", () => {
            const data = [10, 20, 30]
            const result = Array.from(Arrays.iterateAdjacent(data))
            expect(result[0]).toStrictEqual([10, 20])
            expect(result[1]).toStrictEqual([20, 30])
        })
    })

    /* ------------------------------------------------------------------ *
     * isSorted()
     * ------------------------------------------------------------------ */
    describe("isSorted()", () => {
        describe("ascending order (default)", () => {
            it("should return true for ascending arrays", () => {
                expect(Arrays.isSorted([0, 1, 2, 3])).toBe(true)
            })

            it("should return true when adjacent elements are equal", () => {
                expect(Arrays.isSorted([1, 1, 1])).toBe(true)
            })

            it("should return false when not sorted", () => {
                expect(Arrays.isSorted([0, 2, 1])).toBe(false)
            })
        })

        describe("descending order", () => {
            it("should return true for descending arrays", () => {
                expect(Arrays.isSorted([3, 2, 1, 0], Sorting.Descending)).toBe(true)
            })

            it("should return false for ascending arrays in descending mode", () => {
                expect(Arrays.isSorted([0, 1, 2], Sorting.Descending)).toBe(false)
            })
        })
    })

    describe("partition()", () => {
        it("splits by mutually-exclusive predicates", () => {
            const [evens, odds] = Arrays.partition([1, 2, 3, 4, 5],
                (value: number) => value % 2 === 0,
                (value: number) => value % 2 !== 0)
            expect(evens).toEqual([2, 4])
            expect(odds).toEqual([1, 3, 5])
        })

        it("puts each item into every matching bucket (independent filters)", () => {
            const [positive, even] = Arrays.partition([-2, -1, 0, 1, 2, 3],
                (value: number) => value > 0,
                (value: number) => value % 2 === 0)
            expect(positive).toEqual([1, 2, 3])
            expect(even).toEqual([-2, 0, 2])
        })

        it("returns empty buckets when nothing matches", () => {
            const [evens] = Arrays.partition([1, 3, 5],
                (value: number) => value % 2 === 0)
            expect(evens).toEqual([])
        })

        it("returns an empty array of buckets when no predicates are given", () => {
            expect(Arrays.partition([1, 2, 3])).toEqual([])
        })

        it("returns empty buckets when the source array is empty", () => {
            const buckets = Arrays.partition<number>([],
                (value: number) => value > 0,
                (value: number) => value < 0)
            expect(buckets).toEqual([[], []])
        })

        it("preserves source order within each bucket", () => {
            const [matched] = Arrays.partition(["c", "a", "b", "a", "c"],
                (value: string) => value !== "b")
            expect(matched).toEqual(["c", "a", "a", "c"])
        })
    })
})