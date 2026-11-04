import {afterEach, beforeEach, describe, expect, it} from "vitest"
import {Arrays, ByteArrayInput, FloatArray, int, Procedure} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Peaks, SamplePeaks} from "./Peaks"
import {SamplePeakProtocol} from "./SamplePeakProtocol"
import {SamplePeakWorker} from "./SamplePeakWorker"

const createSender = (messenger: Messenger): SamplePeakProtocol =>
    Communicator.sender<SamplePeakProtocol>(messenger.channel("peaks"), router => new class implements SamplePeakProtocol {
        async generateAsync(progress: Procedure<number>, shifts: Uint8Array, frames: ReadonlyArray<FloatArray>,
                            numFrames: int, numChannels: int): Promise<ArrayBufferLike> {
            return router.dispatchAndReturn(this.generateAsync, progress, shifts, frames, numFrames, numChannels)
        }
    })

interface TestingContext {
    input: BroadcastChannel
    output: BroadcastChannel
    peaks: SamplePeakProtocol
}

describe("SamplePeaks.findBestFit", () => {
    it("returns at least one stage for short samples (#494)", () => {
        for (const numFrames of [0, 1, 7, 8, 960, 1199, 1200]) {
            expect(SamplePeaks.findBestFit(numFrames).length).toBeGreaterThan(0)
        }
    })
    it("keeps the stages of longer samples unchanged", () => {
        expect(Array.from(SamplePeaks.findBestFit(1201))).toEqual([3])
        expect(Array.from(SamplePeaks.findBestFit(48_000))).toEqual([3])
        expect(Array.from(SamplePeaks.findBestFit(48_000 * 60))).toEqual([3, 6, 9])
        expect(Array.from(SamplePeaks.findBestFit(48_000 * 600))).toEqual([3, 6, 9, 12])
    })
})

describe("SamplePeakWorker", () => {
    beforeEach<TestingContext>(context => {
        const name = `peaks-${Math.random()}`
        context.input = new BroadcastChannel(name)
        context.output = new BroadcastChannel(name)
        SamplePeakWorker.install(Messenger.for(context.output))
        context.peaks = createSender(Messenger.for(context.input))
    })
    afterEach<TestingContext>(context => {
        context.input.close()
        context.output.close()
    })
    const generate = async (peaks: SamplePeakProtocol, numFrames: int): Promise<Peaks> => {
        const frames = Arrays.create(channel => Float32Array.from({length: numFrames},
            (_, index) => (channel === 0 ? 1 : -1) * (index % 2 === 0 ? 0.5 : -0.25)), 2)
        const buffer = await peaks.generateAsync(() => {}, SamplePeaks.findBestFit(numFrames), frames, numFrames, 2)
        return SamplePeaks.from(new ByteArrayInput(buffer as ArrayBuffer))
    }
    it("generates peaks for a 20 ms sample (960 frames) (#494)", async (context: TestingContext) => {
        const peaks = await generate(context.peaks, 960)
        expect(peaks.numFrames).toBe(960)
        expect(peaks.numChannels).toBe(2)
        expect(peaks.stages.length).toBeGreaterThan(0)
        const bits = peaks.data[0][peaks.stages[0].dataOffset]
        expect(Peaks.unpack(bits, 0)).toBeCloseTo(-0.25)
        expect(Peaks.unpack(bits, 1)).toBeCloseTo(0.5)
    })
    it("generates peaks for a single frame", async (context: TestingContext) => {
        const peaks = await generate(context.peaks, 1)
        expect(peaks.numFrames).toBe(1)
        expect(peaks.stages.length).toBeGreaterThan(0)
    })
    it("generates peaks for an empty sample", async (context: TestingContext) => {
        const peaks = await generate(context.peaks, 0)
        expect(peaks.numFrames).toBe(0)
    })
})
