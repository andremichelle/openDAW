import {describe, expect, it} from "vitest"
import {IterableIterators} from "./iterableIterators"

describe("IterableIterators", () => {
    it("flatten", () => {
        const a = [1, 2, 3]
        const b = [4, 5, 6]
        expect(Array.from(IterableIterators.flatten(a, b))).toStrictEqual([1, 2, 3, 4, 5, 6])
    })
})