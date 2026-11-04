// @vitest-environment jsdom

import {beforeEach, describe, expect, it, vi} from "vitest"
import {WclapZoomMemory} from "@/service/WclapZoomMemory"

describe("WclapZoomMemory", () => {
    beforeEach(() => localStorage.clear())

    it("knows nothing about a plugin that was never zoomed", () => {
        expect(WclapZoomMemory.get("com.example.radar").isEmpty()).toBe(true)
    })

    it("returns the last zoom of each plugin", () => {
        WclapZoomMemory.set("com.example.radar", 1.0)
        WclapZoomMemory.set("com.example.blossom", 1.5)
        WclapZoomMemory.set("com.example.radar", 1.25)
        expect(WclapZoomMemory.get("com.example.radar").unwrap()).toBe(1.25)
        expect(WclapZoomMemory.get("com.example.blossom").unwrap()).toBe(1.5)
    })

    it("ignores what it cannot read", () => {
        localStorage.setItem("wclap-zoom", "not json")
        expect(WclapZoomMemory.get("com.example.radar").isEmpty()).toBe(true)
        localStorage.setItem("wclap-zoom", JSON.stringify({"com.example.radar": "big"}))
        expect(WclapZoomMemory.get("com.example.radar").isEmpty()).toBe(true)
        WclapZoomMemory.set("com.example.radar", 1.0)
        expect(WclapZoomMemory.get("com.example.radar").unwrap()).toBe(1.0)
    })

    it("works without storage", () => {
        const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {throw new Error("blocked")})
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("blocked")})
        expect(() => WclapZoomMemory.set("com.example.radar", 1.0)).not.toThrow()
        expect(WclapZoomMemory.get("com.example.radar").isEmpty()).toBe(true)
        spy.mockRestore()
        vi.restoreAllMocks()
    })
})
