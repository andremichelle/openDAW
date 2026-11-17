import {describe, expect, it} from "vitest"
import {WheelAxis} from "./WheelAxis"

// Each test starts its own gesture far in time after the previous one
let clock = 0.0
const gesture = () => {
    clock += 10_000.0
    let time = clock
    return (deltaX: number, deltaY: number, deltaMode: number = 0, gap: number = 16.0) => {
        time += gap
        return WheelAxis.of({deltaX, deltaY, deltaMode, timeStamp: time} as WheelEvent)
    }
}

describe("WheelAxis", () => {
    it("waits for enough travel before deciding", () => {
        const wheel = gesture()
        expect(wheel(0.5, 1.0)).toBe("undecided")
        expect(wheel(0.5, 1.0)).toBe("undecided")
        expect(wheel(0.0, 2.0)).toBe("vertical")
    })
    it("keeps a vertical gesture vertical despite sideways drift", () => {
        const wheel = gesture()
        expect(wheel(1.0, 6.0)).toBe("vertical")
        expect(wheel(20.0, 1.0)).toBe("vertical")
        expect(wheel(3.0, 0.0)).toBe("vertical")
    })
    it("locks a sideways gesture to horizontal", () => {
        const wheel = gesture()
        expect(wheel(5.0, 1.0)).toBe("horizontal")
        expect(wheel(0.0, 10.0)).toBe("horizontal")
    })
    it("decides anew after a pause", () => {
        const wheel = gesture()
        expect(wheel(0.0, 8.0)).toBe("vertical")
        expect(wheel(8.0, 0.0, 0, 200.0)).toBe("horizontal")
    })
    it("decides a line based mouse notch at once", () => {
        const wheel = gesture()
        expect(wheel(0.0, 1.0, 1)).toBe("vertical")
    })
    it("answers the same event the same way for every listener", () => {
        const event = {deltaX: 6.0, deltaY: 0.0, deltaMode: 0, timeStamp: clock + 50_000.0} as WheelEvent
        expect(WheelAxis.of(event)).toBe("horizontal")
        expect(WheelAxis.of(event)).toBe("horizontal")
    })
})
