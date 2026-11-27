import {describe, expect, it} from "vitest"
import {DuckerHistory, DuckerScale} from "./DuckerHistory"

const broadcast = (counter: number, entries: ReadonlyArray<[number, ReadonlyArray<number>]>): Float32Array => {
    const values = new Float32Array(1 + DuckerHistory.Entries * DuckerHistory.Values)
    values[0] = counter
    entries.forEach(([slot, entry]) => values.set(entry, 1 + slot * DuckerHistory.Values))
    return values
}

describe("DuckerHistory", () => {
    it("ignores the backlog of the first broadcast", () => {
        const history = new DuckerHistory(16)
        expect(history.receive(broadcast(5, [[4, [1, 1, 1, 0.5]]]))).toBe(0)
        expect(history.value(0, 3)).toBe(1.0)
    })

    it("appends only the entries written since the last broadcast, oldest first", () => {
        const history = new DuckerHistory(16)
        history.receive(broadcast(5, []))
        expect(history.receive(broadcast(7, [[5, [0.1, 0.2, 0.3, 0.4]], [6, [0.5, 0.6, 0.7, 0.8]]]))).toBe(2)
        expect(history.value(0, 0)).toBeCloseTo(0.5)
        expect(history.value(1, 3)).toBeCloseTo(0.4)
    })

    it("handles the counter wrap and caps the catch-up at the device ring size", () => {
        const history = new DuckerHistory(128)
        history.receive(broadcast(DuckerHistory.CounterWrap - 1, []))
        expect(history.receive(broadcast(1, [[0, [0.25, 0, 0, 1]]]))).toBe(2)
        expect(history.value(0, 0)).toBeCloseTo(0.25)
        expect(history.receive(broadcast(1000, []))).toBe(DuckerHistory.Entries)
    })
})

describe("DuckerScale", () => {
    it("maps decibels to the display and back", () => {
        expect(DuckerScale.dbToUnit(DuckerScale.DbMax)).toBe(1.0)
        expect(DuckerScale.dbToUnit(-100)).toBe(0.0)
        expect(DuckerScale.unitToDb(DuckerScale.dbToUnit(-12))).toBeCloseTo(-12)
        expect(DuckerScale.gainToUnit(0)).toBe(0.0)
        expect(DuckerScale.reductionToUnit(1.0)).toBe(1.0)
        expect(DuckerScale.reductionToUnit(0.5)).toBeCloseTo(1.0 - 6.0206 / 66)
    })
})
