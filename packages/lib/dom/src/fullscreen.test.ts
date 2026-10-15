import {afterEach, describe, expect, it, vi} from "vitest"
import {RuntimeNotifier} from "@opendaw/lib-std"
import {Fullscreen} from "./fullscreen"

// Safari user scripts may replace requestFullscreen with a wrapper that throws synchronously
// (live error 1181: "null is not an object (evaluating 'e.webkitEnterFullscreen')").
// Fullscreen.request must treat that as a refusal instead of rejecting.
describe("Fullscreen.request", () => {
    afterEach(() => vi.restoreAllMocks())
    const stubElement = (requestFullscreen: () => Promise<void>): Element =>
        ({ownerDocument: {fullscreenEnabled: true}, requestFullscreen} as unknown as Element)
    it("resolves true when the browser enters fullscreen", async () => {
        expect(await Fullscreen.request(stubElement(() => Promise.resolve()))).toBe(true)
    })
    it("resolves false when the browser rejects", async () => {
        const info = vi.spyOn(RuntimeNotifier, "info").mockResolvedValue()
        expect(await Fullscreen.request(stubElement(() => Promise.reject(new TypeError("denied"))))).toBe(false)
        expect(info).toHaveBeenCalledTimes(1)
    })
    it("resolves false when an injected requestFullscreen throws synchronously", async () => {
        const info = vi.spyOn(RuntimeNotifier, "info").mockResolvedValue()
        const element = stubElement(() => {throw new TypeError("null is not an object (evaluating 'e.webkitEnterFullscreen')")})
        expect(await Fullscreen.request(element)).toBe(false)
        expect(info).toHaveBeenCalledTimes(1)
    })
})
