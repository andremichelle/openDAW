// @vitest-environment jsdom

import {beforeEach, describe, expect, it} from "vitest"
import {StageClient} from "./StageClient"

describe("StageClient stored address", () => {
    beforeEach(() => localStorage.clear())

    it("stores the address only", () => {
        StageClient.writeUrl("https://example.com/stage/")
        expect(JSON.parse(localStorage.getItem("stage") ?? "null")).toEqual({url: "https://example.com/stage/"})
        expect(StageClient.readUrl().unwrap()).toBe("https://example.com/stage/")
    })

    it("removes a token stored by an older version and keeps the address", () => {
        localStorage.setItem("stage", JSON.stringify({url: "https://example.com/stage/", token: "secret"}))
        expect(StageClient.readUrl().unwrap()).toBe("https://example.com/stage/")
        expect(localStorage.getItem("stage")).not.toContain("secret")
    })

    it("ignores what it cannot read", () => {
        localStorage.setItem("stage", "not json")
        expect(StageClient.readUrl().isEmpty()).toBe(true)
        localStorage.setItem("stage", JSON.stringify({url: 42}))
        expect(StageClient.readUrl().isEmpty()).toBe(true)
    })

    it("forgets the address", () => {
        StageClient.writeUrl("https://example.com/stage/")
        StageClient.forget()
        expect(StageClient.readUrl().isEmpty()).toBe(true)
    })
})
