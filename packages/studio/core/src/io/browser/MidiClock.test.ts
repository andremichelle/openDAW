import {describe, expect, it} from "vitest"
import {MidiClock} from "./MidiClock"

// Firefox stamps on system uptime: about 16 days ahead of a page's performance.now() on the test machine
const UPTIME = 1_442_748_000

describe("MidiClock", () => {
    it("passes stamps on the page clock through", () => {
        const clock = new MidiClock()
        expect(clock.toPerformanceTime(995.0, 1000.0)).toBe(995.0)
        expect(clock.toPerformanceTime(1003.0, 1000.0)).toBe(1003.0)
    })

    it("maps a foreign stamp to the delivery time of the first message", () => {
        const clock = new MidiClock()
        expect(clock.toPerformanceTime(UPTIME + 1000.0, 1004.0)).toBe(1004.0)
    })

    it("learns the offset from the fastest delivery and keeps the true spacing of later stamps", () => {
        const clock = new MidiClock()
        clock.toPerformanceTime(UPTIME + 1000.0, 1009.0)
        clock.toPerformanceTime(UPTIME + 2000.0, 2001.0)
        // a late handler does not move the stamp: 3000 ms on the foreign clock is 3001 on the page clock
        expect(clock.toPerformanceTime(UPTIME + 3000.0, 3150.0)).toBe(3001.0)
        expect(clock.toPerformanceTime(UPTIME + 3250.0, 3260.0)).toBe(3251.0)
    })
})
