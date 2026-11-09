// #534: an entire-song render stopped after 10 s of silence even when regions followed. The render now runs at
// least to the song end (the last region's completion) before trailing silence may stop it.
import {describe, expect, it} from "vitest"
import {int} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"
import {SilenceTail} from "../src/silence-tail"

const SampleRate = 48_000
const Threshold = 0.00025

const quantum = (value: number): Float32Array[] => [new Float32Array(RenderQuantum).fill(value), new Float32Array(RenderQuantum).fill(value)]

// Feeds quanta until the tail stops or maxQuanta ran, returns the accepted quanta and the frames kept.
const run = (tail: SilenceTail, signal: (frame: int) => number, maxQuanta: int): { accepted: int, kept: int } => {
    let accepted = 0
    while (accepted < maxQuanta && tail.accept(quantum(signal(accepted * RenderQuantum)))) {accepted++}
    return {accepted, kept: tail.framesToKeep}
}

const bursts = (frame: int): number =>
    (frame < 0.2 * SampleRate) || (frame >= 16 * SampleRate && frame < 16.2 * SampleRate) ? 0.5 : 0.0

describe("SilenceTail", () => {
    it("runs past a 10 s gap up to the song end and keeps the second burst", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 16.2 * SampleRate, SampleRate / 4)
        const {accepted, kept} = run(tail, bursts, 1000 * SampleRate / RenderQuantum)
        expect(accepted * RenderQuantum).toBeGreaterThan(16.2 * SampleRate)
        expect(kept).toBe(Math.ceil(16.2 * SampleRate / RenderQuantum) * RenderQuantum + SampleRate / 4)
    })
    it("still stops on a 10 s gap when no minimum is given", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 0, SampleRate / 4)
        const {accepted, kept} = run(tail, bursts, 1000 * SampleRate / RenderQuantum)
        expect(accepted * RenderQuantum).toBeLessThan(16 * SampleRate)
        expect(kept).toBe(Math.ceil(0.2 * SampleRate / RenderQuantum) * RenderQuantum + SampleRate / 4)
    })
    it("keeps exactly a quarter second after the last audio", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 0, SampleRate / 4)
        const {kept} = run(tail, frame => frame < RenderQuantum ? 1.0 : 0.0, 1000 * SampleRate / RenderQuantum)
        expect(kept).toBe(RenderQuantum + SampleRate / 4)
    })
    it("keeps all frames when the render ends on audio", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 0, SampleRate / 4)
        const {accepted, kept} = run(tail, () => 0.5, 100)
        expect(accepted).toBe(100)
        expect(kept).toBe(100 * RenderQuantum)
    })
    it("does not count silence before the first audio", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 0, SampleRate / 4)
        const start = 12 * SampleRate
        const {accepted} = run(tail, frame => frame >= start && frame < start + RenderQuantum ? 1.0 : 0.0,
            1000 * SampleRate / RenderQuantum)
        expect(accepted * RenderQuantum).toBeGreaterThan(start + 10 * SampleRate - RenderQuantum)
    })
    it("trims silence that lies before the song end when nothing follows it", () => {
        const tail = new SilenceTail(Threshold, 10 * SampleRate, 30 * SampleRate, SampleRate / 4)
        const {accepted, kept} = run(tail, frame => frame < RenderQuantum ? 1.0 : 0.0, 1000 * SampleRate / RenderQuantum)
        expect(accepted * RenderQuantum).toBeGreaterThanOrEqual(30 * SampleRate)
        expect(kept).toBe(RenderQuantum + SampleRate / 4)
    })
})
