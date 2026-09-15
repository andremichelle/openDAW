import {describe, expect, it} from "vitest"
import {ClipboardPayload} from "./ClipboardPayload"

// live id 1117: `clipboardData.getData("application/json")` is "" for a plain-text paste, and
// TextInput fed that straight into JSON.parse ("unexpected end of data").

describe("ClipboardPayload.read", () => {
    it("ignores an absent or empty payload", () => {
        expect(ClipboardPayload.read(undefined, "text").isEmpty()).toBe(true)
        expect(ClipboardPayload.read("", "text").isEmpty()).toBe(true)
    })
    it("ignores malformed json and foreign payloads", () => {
        expect(ClipboardPayload.read("{", "text").isEmpty()).toBe(true)
        expect(ClipboardPayload.read("42", "text").isEmpty()).toBe(true)
        expect(ClipboardPayload.read(JSON.stringify({app: "other", content: "text", value: "x"}), "text").isEmpty()).toBe(true)
    })
    it("rejects a payload of another content type", () => {
        expect(ClipboardPayload.read(ClipboardPayload.write("number", 3), "text").isEmpty()).toBe(true)
    })
    it("round-trips its own payload", () => {
        expect(ClipboardPayload.read(ClipboardPayload.write("text", "hello"), "text").unwrap()).toBe("hello")
        expect(ClipboardPayload.read(ClipboardPayload.write("number", 0.5), "number").unwrap()).toBe(0.5)
    })
})
