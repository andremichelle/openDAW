import {describe, expect, it} from "vitest"
import {docs} from "../Tools"

describe("docs", () => {
    it("gives the guide without a query", () => {
        expect(docs("")).toContain("# Getting Started")
    })

    it("gives the declarations that mention the query", () => {
        expect(docs("addInstrumentUnit")).toContain("addInstrumentUnit")
        expect(docs("no such thing here")).toBe("No Script API declaration mentions \"no such thing here\".")
    })
})
