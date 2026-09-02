import {describe, expect, it} from "vitest"
import {isDefined} from "@opendaw/lib-std"
import {RenderQuantum} from "@opendaw/lib-dsp"

if (!isDefined(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}

// Chunks carry a ramp so every frame identifies its own index: channel c of chunk k holds
// frame index * 1 + c * 1000 for the frames it covers.
const chunks = (count: number, channels: number): ReadonlyArray<ReadonlyArray<Float32Array>> =>
    Array.from({length: count}, (_, k) => Array.from({length: channels}, (_, c) =>
        Float32Array.from({length: RenderQuantum}, (_, i) => k * RenderQuantum + i + c * 1000)))

describe("recordedFrames", () => {
    it("keeps the head and drops the overshoot when the limit falls inside a chunk", async () => {
        const {recordedFrames} = await import("./RecordingWorklet")
        const numFrames = 3 * RenderQuantum + 17
        const planes = recordedFrames(chunks(6, 2), numFrames)
        expect(planes.length).toBe(2)
        for (const [c, plane] of planes.entries()) {
            expect(plane.length).toBe(numFrames)
            expect(plane[0]).toBe(c * 1000)
            expect(plane[RenderQuantum]).toBe(RenderQuantum + c * 1000)
            expect(plane[numFrames - 1]).toBe(numFrames - 1 + c * 1000)
        }
    })

    it("returns every frame when the limit is exactly the recorded length", async () => {
        const {recordedFrames} = await import("./RecordingWorklet")
        const numFrames = 4 * RenderQuantum
        const [plane] = recordedFrames(chunks(4, 1), numFrames)
        expect(plane.length).toBe(numFrames)
        expect(plane[0]).toBe(0)
        expect(plane[numFrames - 1]).toBe(numFrames - 1)
    })

    it("keeps the head when the limit ends on a chunk boundary", async () => {
        const {recordedFrames} = await import("./RecordingWorklet")
        const numFrames = 2 * RenderQuantum
        const [plane] = recordedFrames(chunks(5, 1), numFrames)
        expect(plane.length).toBe(numFrames)
        expect(plane[numFrames - 1]).toBe(numFrames - 1)
    })
})
