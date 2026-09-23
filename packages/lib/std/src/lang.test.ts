import {afterEach, describe, expect, it, vi} from "vitest"
import {asEnumValue, getOrProvide, isProvider, requireProperty} from "./lang"

// Simulates a script-blocking extension that swaps the global Function constructor (live 1143)
const stubGlobalFunction = () => {
    vi.stubGlobal("Function", function FakeFunction() {})
    expect((() => 0) instanceof Function).toBe(false)
}

describe("lang", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("asEnumValue", () => {
        enum Strings {A = "EA", B = "EB",}

        enum Numbers {A = 0, B = 1,}

        enum Mixed {A = "AE", B = 1}

        expect(asEnumValue("EA", Strings)).toBe(Strings.A)
        expect(asEnumValue("EB", Strings)).toBe(Strings.B)
        expect(asEnumValue(0, Numbers)).toBe(Numbers.A)
        expect(asEnumValue(1, Numbers)).toBe(Numbers.B)
        expect(() => asEnumValue(2, Numbers)).throws()
        expect(asEnumValue("AE", Mixed)).toBe(Mixed.A)
        expect(asEnumValue(1, Mixed)).toBe(Mixed.B)
    })

    it("isProvider", () => {
        expect(isProvider(() => 1)).toBe(true)
        expect(isProvider(function () {return 1})).toBe(true)
        expect(isProvider(Math.random)).toBe(true)
        expect(isProvider(1)).toBe(false)
        expect(isProvider("text")).toBe(false)
        expect(isProvider({})).toBe(false)
        expect(isProvider([])).toBe(false)
        expect(isProvider(null)).toBe(false)
        expect(isProvider(undefined)).toBe(false)
    })

    it("getOrProvide returns plain values untouched", () => {
        const object = {a: 1}
        const array = [1, 2]
        expect(getOrProvide(42)).toBe(42)
        expect(getOrProvide("text")).toBe("text")
        expect(getOrProvide(object)).toBe(object)
        expect(getOrProvide(array)).toBe(array)
        expect(getOrProvide(null)).toBe(null)
        expect(getOrProvide(undefined)).toBe(undefined)
        expect(getOrProvide(false)).toBe(false)
        expect(getOrProvide(0)).toBe(0)
    })

    it("getOrProvide calls every kind of function", () => {
        class Holder {
            static make(): number {return 7}
            value(): number {return 8}
        }
        const holder = new Holder()
        expect(getOrProvide(() => 1)).toBe(1)
        expect(getOrProvide(function () {return 2})).toBe(2)
        expect(getOrProvide((() => 3).bind(null))).toBe(3)
        expect(getOrProvide(Holder.make)).toBe(7)
        expect(getOrProvide(holder.value.bind(holder))).toBe(8)
        expect(getOrProvide(new Proxy(() => 9, {}))).toBe(9)
    })

    it("getOrProvide evaluates lazily and once", () => {
        const provider = vi.fn(() => "lazy")
        expect(provider).not.toHaveBeenCalled()
        expect(getOrProvide(provider)).toBe("lazy")
        expect(provider).toHaveBeenCalledTimes(1)
    })

    it("getOrProvide survives a replaced global Function", () => {
        stubGlobalFunction()
        expect(getOrProvide(() => 42)).toBe(42)
        expect(getOrProvide(42)).toBe(42)
    })

    it("requireProperty names the owner and passes for present properties", () => {
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
        expect(() => requireProperty(Promise, "resolve")).not.toThrow()
        expect(debug.mock.calls.at(-1)?.[0]).toContain("Promise.resolve")
        expect(() => requireProperty(Array.prototype, "map")).not.toThrow()
        expect(debug.mock.calls.at(-1)?.[0]).toContain("Array.map")
        expect(() => requireProperty(Math, "max")).not.toThrow()
        expect(debug.mock.calls.at(-1)?.[0]).toContain("Object.max")
        debug.mockRestore()
    })

    it("requireProperty throws for absent properties and owners", () => {
        vi.spyOn(console, "debug").mockImplementation(() => {})
        // @ts-expect-error property does not exist
        expect(() => requireProperty(Promise, "nope")).toThrow("Promise.nope not available")
        // @ts-expect-error owner is null
        expect(() => requireProperty(null, "x")).toThrow("x's owner not available")
        // @ts-expect-error owner is undefined
        expect(() => requireProperty(undefined, "x")).toThrow("x's owner not available")
        vi.restoreAllMocks()
    })

    it("requireProperty still names functions when global Function is replaced", () => {
        stubGlobalFunction()
        const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
        requireProperty(Promise, "resolve")
        expect(debug.mock.calls.at(-1)?.[0]).toContain("Promise.resolve")
        expect(debug.mock.calls.at(-1)?.[0]).not.toContain("Function.resolve")
        debug.mockRestore()
    })
})
