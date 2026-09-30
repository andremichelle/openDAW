import {describe, expect, it} from "vitest"
import {runInNewContext} from "node:vm"
import {ErrorInfo} from "./ErrorInfo"

// #1157/#1158: Brave's WebKit cosmetic-filter user script rejected in the page world with a TypeError from
// ITS realm. `instanceof Error` is false there, so the handler could not tell it from our own rejections.
describe("ErrorInfo.isForeignRealmError", () => {
    it("flags an Error created in another realm", () => {
        const foreign: unknown = runInNewContext(
            "new TypeError(\"undefined is not an object (evaluating 'n.standardSelectors')\")")
        expect(foreign instanceof Error).toBe(false)
        expect(ErrorInfo.isForeignRealmError(foreign)).toBe(true)
    })

    it("keeps same-realm errors, including subclasses", () => {
        class Custom extends Error {}
        expect(ErrorInfo.isForeignRealmError(new Error("x"))).toBe(false)
        expect(ErrorInfo.isForeignRealmError(new TypeError("x"))).toBe(false)
        expect(ErrorInfo.isForeignRealmError(new Custom("x"))).toBe(false)
    })

    it("keeps non-error rejection reasons", () => {
        expect(ErrorInfo.isForeignRealmError({name: "TypeError", message: "x"})).toBe(false)
        expect(ErrorInfo.isForeignRealmError("x")).toBe(false)
        expect(ErrorInfo.isForeignRealmError(undefined)).toBe(false)
        expect(ErrorInfo.isForeignRealmError(null)).toBe(false)
        expect(ErrorInfo.isForeignRealmError(runInNewContext("({message: 'x'})"))).toBe(false)
    })
})
