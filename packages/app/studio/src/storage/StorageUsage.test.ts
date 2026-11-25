import {describe, expect, it} from "vitest"
import {StorageUsage} from "./StorageUsage"

describe("StorageUsage.format", () => {
    it("prints gigabytes with two decimals", () => {
        expect(StorageUsage.format(1_460_000_000)).toBe("1.46GB")
        expect(StorageUsage.format(2_000_000_000)).toBe("2.00GB")
    })
    it("prints megabytes and kilobytes rounded", () => {
        expect(StorageUsage.format(820_400_000)).toBe("820MB")
        expect(StorageUsage.format(876_000)).toBe("876kB")
        expect(StorageUsage.format(0)).toBe("0kB")
    })
    it("warns above 75 percent of the allowed storage", () => {
        expect(StorageUsage.exceeds(750_000_001, 1_000_000_000)).toBe(true)
        expect(StorageUsage.exceeds(750_000_000, 1_000_000_000)).toBe(false)
    })
    it("does not warn while the allowed storage is unknown", () => {
        expect(StorageUsage.isCritical(Number.MAX_SAFE_INTEGER)).toBe(false)
    })
})
