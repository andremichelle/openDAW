import {describe, expect, it} from "vitest"
import {RoundTrip} from "./RoundTrip"

const SAMPLE_RATE = 48_000

// a deterministic noise floor
const noise = (length: number, level: number): Float32Array => {
    const values = new Float32Array(length)
    let seed = 12345
    for (let index = 0; index < length; index++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        values[index] = (seed / 0x7fffffff * 2.0 - 1.0) * level
    }
    return values
}

// adds the probe at a fractional frame, linearly interpolated
const place = (target: Float32Array, probe: Float32Array, frame: number, gain: number): void => {
    const whole = Math.floor(frame)
    const fraction = frame - whole
    for (let index = 0; index < probe.length; index++) {
        const at = whole + index
        if (at >= 0 && at < target.length) {target[at] += probe[index] * (1.0 - fraction) * gain}
        if (at + 1 >= 0 && at + 1 < target.length) {target[at + 1] += probe[index] * fraction * gain}
    }
}

const capture = (delays: ReadonlyArray<number>, level: number = 0.1) => {
    const probe = RoundTrip.probe()
    const firstFrameTime = 2.0
    const spacing = probe.length / SAMPLE_RATE + RoundTrip.BurstGapSeconds
    const emissions = delays.map((_, index) => firstFrameTime + 0.2 + index * spacing)
    const captured = noise(Math.round((0.6 + delays.length * spacing + 1.0) * SAMPLE_RATE), 0.05)
    delays.forEach((delay, index) =>
        place(captured, probe, (emissions[index] + delay - firstFrameTime) * SAMPLE_RATE, level))
    return RoundTrip.analyse(captured, firstFrameTime, SAMPLE_RATE, emissions, probe)
}

describe("RoundTrip", () => {
    it("generates a maximum length sequence", () => {
        const probe = RoundTrip.probe()
        expect(probe.length).toBe(16383)
        const ones = probe.filter(value => value > 0).length
        expect(ones).toBe(8192)
    })

    it("finds the delay of every burst", () => {
        const result = capture([0.0186, 0.0186, 0.0186])
        expect(result.verdict).toBe("ok")
        expect(result.heard).toBe(3)
        expect(Math.abs(result.seconds - 0.0186) * SAMPLE_RATE).toBeLessThan(0.25)
    })

    it("finds a delay between samples", () => {
        const delay = 1000.4 / SAMPLE_RATE
        const result = capture([delay, delay, delay])
        expect(Math.abs(result.seconds - delay) * SAMPLE_RATE).toBeLessThan(0.25)
    })

    it("finds a Bluetooth sized delay in quiet bursts", () => {
        const result = capture([0.285, 0.285, 0.285], 0.02)
        expect(result.verdict).toBe("ok")
        expect(Math.abs(result.seconds - 0.285) * SAMPLE_RATE).toBeLessThan(0.25)
    })

    it("hears nothing in noise without the probe", () => {
        const result = capture([0.02, 0.02, 0.02], 0.0)
        expect(result.verdict).toBe("no-signal")
        expect(result.heard).toBe(0)
    })

    it("calls bursts that disagree unsteady and reports the median", () => {
        const result = capture([0.018, 0.0205, 0.042])
        expect(result.verdict).toBe("unsteady")
        expect(result.seconds).toBeCloseTo(0.0205, 4)
        expect(result.spreadSeconds).toBeCloseTo(0.024, 4)
    })
})
