import {describe, expect, it} from "vitest"
import {whenLoaded} from "./whenLoaded"

type Fake = { closed: boolean, location: { href: string }, document: { readyState: string }, __shellClose__?: () => void }

const fake = (): Fake => ({closed: false, location: {href: "about:blank"}, document: {readyState: "loading"}})
const settle = (promise: Promise<boolean>, millis: number) =>
    Promise.race([promise, new Promise<string>(resolve => setTimeout(() => resolve("pending"), millis))])

// The desktop app sets up its windows (resizeBy, drag, close go through the shell) after the document loaded. A window
// used before that loses those calls: a WebCLAP window opened one header too short (2026-10-18).
describe("a new window", () => {
    it("in a browser is ready with its document", async () => {
        const owner = fake()
        const ready = whenLoaded(owner as unknown as WindowProxy, false)
        owner.location.href = "http://localhost/popout.html"
        owner.document.readyState = "complete"
        expect(await settle(ready, 100)).toBe(true)
    })

    it("in the desktop app waits until the shell set it up", async () => {
        const owner = fake()
        const ready = whenLoaded(owner as unknown as WindowProxy, true)
        owner.location.href = "http://127.0.0.1:47110/popout.html"
        owner.document.readyState = "complete"
        expect(await settle(ready, 100)).toBe("pending")
        owner.__shellClose__ = () => {}
        expect(await settle(ready, 100)).toBe(true)
    })

    it("closed before it loaded is not ready", async () => {
        const owner = fake()
        const ready = whenLoaded(owner as unknown as WindowProxy, true)
        owner.closed = true
        expect(await settle(ready, 100)).toBe(false)
    })
})
