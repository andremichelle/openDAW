import {describe, expect, it} from "vitest"
import {Strings} from "./strings"

describe("Strings.getUniqueName", () => {
    it("returns the desired name when it is free", () => {
        expect(Strings.getUniqueName([], "Foo")).toBe("Foo")
        expect(Strings.getUniqueName(["Bar", "Baz"], "Foo")).toBe("Foo")
    })

    it("appends a numeric suffix on collision", () => {
        expect(Strings.getUniqueName(["Foo"], "Foo")).toBe("Foo 2")
        expect(Strings.getUniqueName(["Foo", "Foo 2"], "Foo")).toBe("Foo 3")
        expect(Strings.getUniqueName(["Foo", "Foo 2", "Foo 3"], "Foo")).toBe("Foo 4")
    })

    it("increments an existing trailing number instead of appending another", () => {
        expect(Strings.getUniqueName(["Foo 2"], "Foo 2")).toBe("Foo 3")
        expect(Strings.getUniqueName(["Foo 2", "Foo 3"], "Foo 2")).toBe("Foo 4")
        expect(Strings.getUniqueName(["Bar 10"], "Bar 10")).toBe("Bar 11")
    })

    it("leaves a numbered name untouched when it is free", () => {
        expect(Strings.getUniqueName(["Foo"], "Foo 2")).toBe("Foo 2")
        expect(Strings.getUniqueName([], "Foo 5")).toBe("Foo 5")
    })

    it("treats a multi-segment numbered name by incrementing its last number", () => {
        expect(Strings.getUniqueName(["Foo 2 2"], "Foo 2 2")).toBe("Foo 2 3")
    })

    it("does not mistake a digit glued to text for a counter", () => {
        expect(Strings.getUniqueName(["v2"], "v2")).toBe("v2 2")
    })

    it("fills the first available gap", () => {
        expect(Strings.getUniqueName(["Foo", "Foo 3"], "Foo")).toBe("Foo 2")
    })
})
