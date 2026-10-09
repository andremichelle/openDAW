// Issue 424: Chrome's worklet scope clock (currentFrame/currentTime) is only advanced at the end of a quantum when the
// audio graph lock is free (crbug 442866743). While the main thread connects nodes, a read can carry the previous
// quantum's frame (or older) and then jump to the true one. Reads are only ever early, never late.
import {describe, expect, it} from "vitest"
import {QuantumClock} from "./quantum-clock"
import {RenderQuantum} from "./constants"

const Q = RenderQuantum

describe("QuantumClock", () => {
    it("passes true reads through", () => {
        const clock = new QuantumClock()
        for (let call = 0; call < 8; call++) {
            expect(clock.advance(1000 * Q + call * Q)).toBe(1000 * Q + call * Q)
        }
        expect(clock.calls).toBe(8)
        expect(clock.frameOf(3)).toBe(1003 * Q)
    })

    it("corrects a read that stands still for one quantum", () => {
        const clock = new QuantumClock()
        const reads = [10, 11, 11, 13, 14].map(index => index * Q)
        expect(reads.map(read => clock.advance(read))).toEqual([10, 11, 12, 13, 14].map(index => index * Q))
    })

    it("corrects a read that stands still for several quanta", () => {
        const clock = new QuantumClock()
        const reads = [10, 11, 11, 11, 11, 15, 16].map(index => index * Q)
        expect(reads.map(read => clock.advance(read))).toEqual([10, 11, 12, 13, 14, 15, 16].map(index => index * Q))
    })

    it("corrects a stale FIRST read retroactively once a true read arrives", () => {
        const clock = new QuantumClock()
        clock.advance(9 * Q) // true frame is 10 * Q: a fresh worklet reading its first frame one quantum early
        expect(clock.frameOf(0)).toBe(9 * Q)
        clock.advance(11 * Q)
        expect(clock.frameOf(0)).toBe(10 * Q)
        clock.advance(12 * Q)
        expect(clock.frameOf(0)).toBe(10 * Q)
        expect(clock.frameOf(2)).toBe(12 * Q)
    })

    it("follows a forward jump (calls skipped while the clock ran on)", () => {
        const clock = new QuantumClock()
        clock.advance(10 * Q)
        clock.advance(11 * Q)
        expect(clock.advance(20 * Q)).toBe(20 * Q)
        expect(clock.advance(21 * Q)).toBe(21 * Q)
    })
})
