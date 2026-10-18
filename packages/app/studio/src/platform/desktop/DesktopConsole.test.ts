import {describe, expect, it} from "vitest"
import {DesktopConsole} from "./DesktopConsole"

// what reaches openDAW.log from the studio's console: one line per call, readable without the inspector
describe("DesktopConsole.format", () => {
    it("joins strings, numbers and objects like the console", () => {
        expect(DesktopConsole.format(["[boot] fonts", 3, {ready: true}, null, undefined])).toBe(`[boot] fonts 3 {"ready":true} null undefined`)
    })

    it("names an error with its stack", () => {
        const error = new Error("broken")
        expect(DesktopConsole.format(["failed", error])).toContain("broken")
        expect(DesktopConsole.format(["failed", error])).toContain("DesktopConsole.test")
    })

    it("survives values JSON cannot write and stays one bounded line", () => {
        const circular: { self?: unknown } = {}
        circular.self = circular
        expect(DesktopConsole.format([circular])).toBe("[object Object]")
        const long = DesktopConsole.format(["x".repeat(10_000)])
        expect(long.length).toBeLessThanOrEqual(2000)
        expect(DesktopConsole.format(["a\nb"])).toBe("a\\nb")
    })
})
