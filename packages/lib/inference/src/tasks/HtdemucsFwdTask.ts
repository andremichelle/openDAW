import {asDefined, clampUnit, panic} from "@opendaw/lib-std"
import {defineTask, TaskDefinition, TaskEnvironment} from "../Task"
import {tensor, TensorMap} from "../Tensor"
import {StemSeparationInput, StemSeparationOutput} from "./StemSeparationTask"
import {buildTriangularWeights, chunkStereo} from "./htdemucs-fwd/Chunker"
import {HOP, NUM_STEMS, SEGMENT_LENGTH, STEM_NAMES, STFT_FREQ_BINS, STFT_TIME_FRAMES, TARGET_SAMPLE_RATE} from "./htdemucs-fwd/Constants"
import {buildPartial, PartialStemResult} from "./htdemucs-fwd/Partial"
import {htdemucsPostForward} from "./htdemucs-fwd/PostForward"
import {htdemucsPreForward} from "./htdemucs-fwd/PreForward"
import {StftContext} from "./htdemucs-fwd/Stft"

type StemBuffers = [left: Float32Array, right: Float32Array]

const toPlanar = (buffers: StemBuffers, channels: 1 | 2, totalSamples: number): Float32Array => {
    const [left, right] = buffers
    if (channels === 1) {
        const mono = new Float32Array(totalSamples)
        for (let i = 0; i < totalSamples; i++) {mono[i] = (left[i] + right[i]) * 0.5}
        return mono
    }
    const planar = new Float32Array(2 * totalSamples)
    planar.set(left, 0)
    planar.set(right, totalSamples)
    return planar
}

const htdemucsFwdRun = async (
    input: StemSeparationInput,
    env: TaskEnvironment<PartialStemResult>
): Promise<StemSeparationOutput> => {
    if (input.sampleRate !== TARGET_SAMPLE_RATE) {
        return panic(`htdemucs-fwd requires ${TARGET_SAMPLE_RATE} Hz; got ${input.sampleRate}`)
    }
    const samplesPerChannel = input.audio.length / input.channels
    const left = input.audio.subarray(0, samplesPerChannel)
    const right = input.channels === 2 ? input.audio.subarray(samplesPerChannel, 2 * samplesPerChannel) : left
    const stft = new StftContext()
    const {segments, totalSamples} = chunkStereo(left, right)
    const weights = buildTriangularWeights()
    const stemBuffers: Record<string, StemBuffers> = {}
    for (const stemName of STEM_NAMES) {
        stemBuffers[stemName] = [new Float32Array(totalSamples), new Float32Array(totalSamples)]
    }
    const weightSum = new Float32Array(totalSamples)
    let frontier = 0
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        env.signal.match({none: () => {}, some: (signal: AbortSignal) => signal.throwIfAborted()})
        const segment = segments[segmentIndex]
        const pre = htdemucsPreForward(stft, segment.data)
        const feeds: TensorMap = {
            x:  tensor("float32", pre.xBuf, [1, 4, STFT_FREQ_BINS, STFT_TIME_FRAMES]),
            xt: tensor("float32", pre.xtBuf, [1, 2, SEGMENT_LENGTH])
        }
        const output = await env.session(feeds)
        const xOut = asDefined(output.x_out, "Missing output: x_out").data as Float32Array
        const xtOut = asDefined(output.xt_out, "Missing output: xt_out").data as Float32Array
        const sources = htdemucsPostForward(stft, xOut, xtOut, pre)
        const writeLimit = Math.min(SEGMENT_LENGTH, totalSamples - segment.startSample)
        for (let stemIndex = 0; stemIndex < NUM_STEMS; stemIndex++) {
            const [stemLeft, stemRight] = stemBuffers[STEM_NAMES[stemIndex]]
            const offsetLeft = stemIndex * 2 * SEGMENT_LENGTH
            const offsetRight = offsetLeft + SEGMENT_LENGTH
            for (let k = 0; k < writeLimit; k++) {
                const weight = weights[k]
                const destIndex = segment.startSample + k
                stemLeft[destIndex] += sources[offsetLeft + k] * weight
                stemRight[destIndex] += sources[offsetRight + k] * weight
            }
        }
        for (let k = 0; k < writeLimit; k++) {weightSum[segment.startSample + k] += weights[k]}
        env.progress(clampUnit((segmentIndex + 1) / segments.length))

        // Sample i's last-ever contribution comes from segment floor(i/HOP), since consecutive
        // segments start HOP apart - so [frontier, newFrontier) is safe to divide-and-finalize now,
        // bit-identical to dividing the whole buffer once at the end.
        const newFrontier = segment.isLast ? totalSamples : Math.min((segmentIndex + 1) * HOP, totalSamples)
        for (const stemName of STEM_NAMES) {
            const [stemLeft, stemRight] = stemBuffers[stemName]
            for (let i = frontier; i < newFrontier; i++) {
                const sum = weightSum[i]
                if (sum > 0) {stemLeft[i] /= sum; stemRight[i] /= sum}
            }
        }
        env.onPartial?.(buildPartial(stemBuffers, input.channels, input.sampleRate, frontier, newFrontier))
        frontier = newFrontier
    }
    return {
        drums:  toPlanar(stemBuffers.drums, input.channels, totalSamples),
        bass:   toPlanar(stemBuffers.bass, input.channels, totalSamples),
        other:  toPlanar(stemBuffers.other, input.channels, totalSamples),
        vocals: toPlanar(stemBuffers.vocals, input.channels, totalSamples),
        sampleRate: input.sampleRate,
        channels: input.channels
    }
}

/**
 * htdemucs v4, fwd-only split export: STFT/iSTFT and normalization run in TS
 * (`htdemucs-fwd/`), leaving only the inner transformer/conv network in the
 * ONNX graph. Measured as a single WebNN partition covering 100% of graph
 * nodes (vs. 43 partitions / 19% coverage for the other stem-separation
 * tasks' single-file, STFT-in-graph exports), so it's the only one of the
 * three that runs correctly on WebNN-NPU.
 */
export const HtdemucsFwdTask: TaskDefinition<StemSeparationInput, StemSeparationOutput, PartialStemResult> =
    defineTask<StemSeparationInput, StemSeparationOutput, PartialStemResult>({
        key: "stem-separation-webnn",
        model: {
            url: "https://huggingface.co/arisha07/stem-separator/resolve/main/onnx/htdemucs_fwd_embedded/htdemucs_fwd_embedded.onnx",
            sha256: "2d4b9ac28eb380c0d862ce157e0782871f4dfd86c316c31c1953995b79ee2b61",
            bytes: 170_650_559,
            version: "fwd-embedded-v1"
        },
        executionProviders: ["webnn-npu", "webnn-gpu", "webgpu", "wasm"],
        run: htdemucsFwdRun
    })
