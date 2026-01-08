import {describe, expect, it} from "vitest"
import {RegionClipResolver} from "./RegionClipResolver"

interface Mask {
    type: string
    position: number
    complete: number
}

const createMask = (position: number, complete: number): Mask => ({type: "range", position, complete})

describe("RegionClipResolver.sortAndJoinMasks", () => {
    it("should handle single mask", () => {
        const masks = [createMask(0, 10)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 10))
    })

    it("should merge two adjacent masks", () => {
        const masks = [createMask(0, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should keep two non-adjacent masks separate", () => {
        const masks = [createMask(0, 10), createMask(15, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(2)
        expect(result[0]).toEqual(createMask(0, 10))
        expect(result[1]).toEqual(createMask(15, 20))
    })

    it("should merge two overlapping masks", () => {
        const masks = [createMask(0, 15), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle mask completely contained in another", () => {
        const masks = [createMask(0, 100), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 100))
    })

    it("should handle multiple masks completely contained in one", () => {
        const masks = [
            createMask(0, 100),
            createMask(10, 20),
            createMask(30, 40),
            createMask(50, 60)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 100))
    })

    it("should sort unsorted masks before merging", () => {
        const masks = [createMask(20, 30), createMask(0, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 30))
    })

    it("should merge multiple overlapping masks into one", () => {
        const masks = [
            createMask(0, 15),
            createMask(10, 25),
            createMask(20, 35),
            createMask(30, 40)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 40))
    })

    it("should create multiple ranges for separated groups", () => {
        const masks = [
            createMask(0, 10),
            createMask(10, 20),
            createMask(30, 40),
            createMask(40, 50),
            createMask(60, 70)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(3)
        expect(result[0]).toEqual(createMask(0, 20))
        expect(result[1]).toEqual(createMask(30, 50))
        expect(result[2]).toEqual(createMask(60, 70))
    })

    it("should handle complex mix of overlapping and separated masks", () => {
        const masks = [
            createMask(0, 15),
            createMask(10, 25),
            createMask(50, 60),
            createMask(55, 70),
            createMask(100, 110)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(3)
        expect(result[0]).toEqual(createMask(0, 25))
        expect(result[1]).toEqual(createMask(50, 70))
        expect(result[2]).toEqual(createMask(100, 110))
    })

    it("should handle masks with same start position", () => {
        const masks = [
            createMask(0, 10),
            createMask(0, 20),
            createMask(0, 15)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle masks with same end position", () => {
        const masks = [
            createMask(0, 20),
            createMask(10, 20),
            createMask(5, 20)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 20))
    })

    it("should handle identical masks", () => {
        const masks = [
            createMask(0, 10),
            createMask(0, 10),
            createMask(0, 10)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(0, 10))
    })

    it("should handle zero-length masks (position equals complete)", () => {
        const masks = [createMask(10, 10), createMask(20, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(2)
        expect(result[0]).toEqual(createMask(10, 10))
        expect(result[1]).toEqual(createMask(20, 20))
    })

    it("should merge adjacent zero-length and non-zero-length masks", () => {
        const masks = [createMask(10, 10), createMask(10, 20)]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(1)
        expect(result[0]).toEqual(createMask(10, 20))
    })

    it("should not mutate input array", () => {
        const masks = [createMask(20, 30), createMask(0, 10), createMask(10, 20)]
        const original = [...masks]

        RegionClipResolver.sortAndJoinMasks(masks)

        expect(masks).toEqual(original)
    })

    it("should handle large number of masks", () => {
        const masks: Mask[] = []
        for (let i = 0; i < 100; i++) {
            masks.push(createMask(i * 5, i * 5 + 10))
        }

        const result = RegionClipResolver.sortAndJoinMasks(masks)

        // All masks overlap, should merge into one
        expect(result).toHaveLength(1)
        expect(result[0].position).toBe(0)
        expect(result[0].complete).toBe(505) // 99 * 5 + 10
    })

    it("should handle masks in reverse order", () => {
        const masks = [
            createMask(60, 70),
            createMask(40, 50),
            createMask(20, 30),
            createMask(0, 10)
        ]
        const result = RegionClipResolver.sortAndJoinMasks(masks)

        expect(result).toHaveLength(4)
        expect(result[0]).toEqual(createMask(0, 10))
        expect(result[1]).toEqual(createMask(20, 30))
        expect(result[2]).toEqual(createMask(40, 50))
        expect(result[3]).toEqual(createMask(60, 70))
    })
})