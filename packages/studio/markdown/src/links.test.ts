import {describe, expect, it} from "vitest"
import {isManualsPath} from "./links"

describe("isManualsPath", () => {
    it("matches the manuals subtree", () => {
        expect(isManualsPath("/manuals")).toBe(true)
        expect(isManualsPath("/manuals/")).toBe(true)
        expect(isManualsPath("/manuals/devices/audio/dattorro-reverb")).toBe(true)
    })
    it("leaves studio routes to full navigation", () => {
        expect(isManualsPath("/")).toBe(false)
        expect(isManualsPath("/preferences")).toBe(false)
        expect(isManualsPath("/docs/scripting/")).toBe(false)
        expect(isManualsPath("/manual")).toBe(false)
    })
})
