import {describe, expect, it} from "vitest"
import {Option} from "@opendaw/lib-std"
import {tensor, TensorMap} from "../Tensor"
import {HtdemucsFwdTask} from "./HtdemucsFwdTask"
import {buildTriangularWeights, chunkStereo} from "./htdemucs-fwd/Chunker"
import {HOP, NUM_STEMS, OVERLAP, SEGMENT_LENGTH, STEM_NAMES, STFT_FREQ_BINS, STFT_TIME_FRAMES} from "./htdemucs-fwd/Constants"
import {PartialStemResult} from "./htdemucs-fwd/Partial"

describe("chunkStereo", () => {
    it("returns a single segment when input fits within one window", () => {
        const left = new Float32Array(SEGMENT_LENGTH)
        const right = new Float32Array(SEGMENT_LENGTH)
        const {segments, totalSamples} = chunkStereo(left, right)
        expect(segments.length).toBe(1)
        expect(segments[0].startSample).toBe(0)
        expect(segments[0].isLast).toBe(true)
        expect(totalSamples).toBe(SEGMENT_LENGTH)
    })

    it("strides by HOP for longer input", () => {
        const length = SEGMENT_LENGTH + HOP
        const left = new Float32Array(length)
        const right = new Float32Array(length)
        const {segments} = chunkStereo(left, right)
        expect(segments.length).toBe(2)
        expect(segments[0].startSample).toBe(0)
        expect(segments[1].startSample).toBe(HOP)
    })

    it("pads the final segment to SEGMENT_LENGTH", () => {
        const length = SEGMENT_LENGTH + 100
        const left = new Float32Array(length)
        const right = new Float32Array(length)
        const {segments} = chunkStereo(left, right)
        const last = segments[segments.length - 1]
        expect(last.data.length).toBe(2 * SEGMENT_LENGTH)
        expect(last.padSamples).toBeGreaterThan(0)
    })
})

describe("buildTriangularWeights", () => {
    it("ramps up over the first OVERLAP samples", () => {
        const weights = buildTriangularWeights()
        expect(weights[0]).toBeCloseTo(1 / OVERLAP, 5)
        expect(weights[OVERLAP - 1]).toBeCloseTo(1, 5)
    })

    it("is 1.0 in the flat middle region", () => {
        const weights = buildTriangularWeights()
        expect(weights[SEGMENT_LENGTH / 2]).toBe(1.0)
    })

    it("ramps down over the final OVERLAP samples", () => {
        const weights = buildTriangularWeights()
        expect(weights[SEGMENT_LENGTH - 1]).toBeCloseTo(1 / OVERLAP, 5)
    })
})

describe("HtdemucsFwdTask integration (with mock session)", () => {
    const makeFakeSession = (callCount: {count: number}) => async (feeds: TensorMap): Promise<TensorMap> => {
        callCount.count++
        expect(feeds.x.dims).toEqual([1, 4, STFT_FREQ_BINS, STFT_TIME_FRAMES])
        expect(feeds.xt.dims).toEqual([1, 2, SEGMENT_LENGTH])
        const xOutLen = NUM_STEMS * 4 * STFT_FREQ_BINS * STFT_TIME_FRAMES
        const xtOutLen = NUM_STEMS * 2 * SEGMENT_LENGTH
        return {
            x_out:  tensor("float32", new Float32Array(xOutLen), [1, 16, STFT_FREQ_BINS, STFT_TIME_FRAMES]),
            xt_out: tensor("float32", new Float32Array(xtOutLen), [1, 8, SEGMENT_LENGTH])
        }
    }

    it("calls the session once per segment and returns 4 planar stems", async () => {
        const sampleRate = 44100
        const samplesPerChannel = SEGMENT_LENGTH // exactly one segment
        const channels = 2 as const
        const audio = new Float32Array(samplesPerChannel * channels)
        for (let i = 0; i < samplesPerChannel; i++) {
            audio[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate))
            audio[samplesPerChannel + i] = audio[i]
        }
        const callCount = {count: 0}
        const progressValues: Array<number> = []
        const result = await HtdemucsFwdTask.run({audio, channels, sampleRate}, {
            session: makeFakeSession(callCount),
            progress: value => progressValues.push(value),
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"]
        })
        expect(callCount.count).toBe(1)
        expect(result.drums.length).toBe(audio.length)
        expect(result.bass.length).toBe(audio.length)
        expect(result.other.length).toBe(audio.length)
        expect(result.vocals.length).toBe(audio.length)
        expect(result.sampleRate).toBe(sampleRate)
        expect(result.channels).toBe(2)
        expect(progressValues[progressValues.length - 1]).toBeCloseTo(1, 5)
    })

    it("duplicates mono input to stereo for inference and returns mono output", async () => {
        const sampleRate = 44100
        const samplesPerChannel = SEGMENT_LENGTH
        const channels = 1 as const
        const audio = new Float32Array(samplesPerChannel)
        for (let i = 0; i < samplesPerChannel; i++) {audio[i] = Math.sin(2 * Math.PI * 220 * (i / sampleRate))}
        const callCount = {count: 0}
        const result = await HtdemucsFwdTask.run({audio, channels, sampleRate}, {
            session: makeFakeSession(callCount),
            progress: () => {},
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"]
        })
        expect(result.channels).toBe(1)
        expect(result.drums.length).toBe(audio.length)
    })

    it("rejects non-44100Hz input", async () => {
        await expect(HtdemucsFwdTask.run(
            {audio: new Float32Array(48000), channels: 1, sampleRate: 48000},
            {
                session: async () => ({}),
                progress: () => {},
                signal: Option.None,
                inputNames: ["x", "xt"],
                outputNames: ["x_out", "xt_out"]
            }
        )).rejects.toThrow(/44100/)
    })
})

describe("HtdemucsFwdTask onPartial streaming", () => {
    // Non-zero so a double-division (or skipped-division) bug at segment boundaries shows up as a
    // numeric mismatch rather than coincidentally staying zero either way.
    const makeConstantFakeSession = () => async (): Promise<TensorMap> => {
        const xOutLen = NUM_STEMS * 4 * STFT_FREQ_BINS * STFT_TIME_FRAMES
        const xtOutLen = NUM_STEMS * 2 * SEGMENT_LENGTH
        return {
            x_out:  tensor("float32", new Float32Array(xOutLen).fill(1), [1, 16, STFT_FREQ_BINS, STFT_TIME_FRAMES]),
            xt_out: tensor("float32", new Float32Array(xtOutLen).fill(1), [1, 8, SEGMENT_LENGTH])
        }
    }

    const makeInput = (segmentCount: 1 | 2) => {
        const sampleRate = 44100
        const samplesPerChannel = segmentCount === 1 ? SEGMENT_LENGTH : SEGMENT_LENGTH + HOP
        const channels = 2 as const
        const audio = new Float32Array(samplesPerChannel * channels)
        for (let i = 0; i < samplesPerChannel; i++) {
            audio[i] = Math.sin(2 * Math.PI * 440 * (i / sampleRate))
            audio[samplesPerChannel + i] = audio[i]
        }
        return {audio, channels, sampleRate}
    }

    it("reconstructs the exact final output by concatenating partials in order", async () => {
        // Runs the real 2-segment STFT/iSTFT pipeline twice (with and without a listener) - slower
        // than the default 5s budget.
        const input = makeInput(2)
        const partials: Array<PartialStemResult> = []
        const result = await HtdemucsFwdTask.run(input, {
            session: makeConstantFakeSession(),
            progress: () => {},
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"],
            onPartial: partial => partials.push(partial)
        })
        const resultNoListener = await HtdemucsFwdTask.run(input, {
            session: makeConstantFakeSession(),
            progress: () => {},
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"]
        })
        for (const stemName of STEM_NAMES) {
            expect(result[stemName]).toEqual(resultNoListener[stemName])
        }
        for (const stemName of STEM_NAMES) {
            const reconstructed = new Float32Array(result[stemName].length)
            const totalSamples = reconstructed.length / input.channels
            for (const partial of partials) {
                const length = partial.toSample - partial.fromSample
                for (let channel = 0; channel < input.channels; channel++) {
                    const source = partial[stemName].subarray(channel * length, (channel + 1) * length)
                    reconstructed.set(source, channel * totalSamples + partial.fromSample)
                }
            }
            expect(reconstructed).toEqual(result[stemName])
        }
    }, 20_000)

    it("advances the frontier monotonically with no gaps or overlaps", async () => {
        const input = makeInput(2)
        const partials: Array<PartialStemResult> = []
        await HtdemucsFwdTask.run(input, {
            session: makeConstantFakeSession(),
            progress: () => {},
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"],
            onPartial: partial => partials.push(partial)
        })
        expect(partials[0].fromSample).toBe(0)
        for (let i = 1; i < partials.length; i++) {
            expect(partials[i].fromSample).toBe(partials[i - 1].toSample)
        }
        expect(partials[partials.length - 1].toSample).toBe(SEGMENT_LENGTH + HOP)
    })

    it("pins exact frontier boundaries for a known 2-segment input", async () => {
        const input = makeInput(2)
        const partials: Array<PartialStemResult> = []
        await HtdemucsFwdTask.run(input, {
            session: makeConstantFakeSession(),
            progress: () => {},
            signal: Option.None,
            inputNames: ["x", "xt"],
            outputNames: ["x_out", "xt_out"],
            onPartial: partial => partials.push(partial)
        })
        expect(partials.length).toBe(2)
        expect(partials[0].fromSample).toBe(0)
        expect(partials[0].toSample).toBe(HOP)
        expect(partials[1].fromSample).toBe(HOP)
        expect(partials[1].toSample).toBe(SEGMENT_LENGTH + HOP)
    })
})
