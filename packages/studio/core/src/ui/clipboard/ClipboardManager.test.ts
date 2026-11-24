import {describe, expect, it, vi} from "vitest"
import {ClipboardManager} from "./ClipboardManager"

const entryOf = (values: ReadonlyArray<number>) => ({type: "notes", data: new Uint8Array(values).buffer})

const bytesOf = (text: string): ReadonlyArray<number> =>
    ClipboardManager.decode(text).match({none: () => [], some: entry => Array.from(new Uint8Array(entry.data))})

describe("ClipboardManager encode/decode", () => {
    it("round-trips data with length and checksum", () => {
        const text = ClipboardManager.encode(entryOf([0, 1, 2, 250, 255, 128]))
        expect(text.split(":").length).toBe(6)
        expect(bytesOf(text)).toEqual([0, 1, 2, 250, 255, 128])
    })
    it("still reads text without length and checksum (written by older builds)", () => {
        const [header, version, type, base64] = ClipboardManager.encode(entryOf([7, 8, 9])).split(":")
        expect(bytesOf([header, version, type, base64].join(":"))).toEqual([7, 8, 9])
    })
    // live errors 1353 and 1354: pasted notes data carried a garbage length
    it("rejects data that changed after the copy", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        const parts = ClipboardManager.encode(entryOf([1, 2, 3, 4, 5, 6])).split(":")
        const tampered = btoa(String.fromCharCode(1, 2, 3, 4, 5, 7))
        expect(ClipboardManager.decode([...parts.slice(0, 3), tampered, ...parts.slice(4)].join(":")).isEmpty()).toBe(true)
        const truncated = btoa(String.fromCharCode(1, 2, 3))
        expect(ClipboardManager.decode([...parts.slice(0, 3), truncated, ...parts.slice(4)].join(":")).isEmpty()).toBe(true)
        expect(warn).toHaveBeenCalledTimes(2)
        warn.mockRestore()
    })
    it("rejects unreadable base64", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        expect(ClipboardManager.decode("OPENDAW:2:notes:%%%").isEmpty()).toBe(true)
        warn.mockRestore()
    })
})
