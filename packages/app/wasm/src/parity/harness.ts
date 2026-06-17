// Parity-harness skeleton (plans/wasm-audio/07-testing.md). Renders the wasm engine offline,
// renders a TS reference, and null-tests the two. The reference is the TS engine; for the skeleton
// it is a TS port of the sine, swapped for the real engine output as features land.
import {readFileSync} from "node:fs"

export type Residual = {peak: number, rms: number}

/** Subtract two signals and measure the residual (the null test). */
export const nullTest = (rendered: Float32Array, reference: Float32Array): Residual => {
    if (rendered.length !== reference.length) {
        throw new Error(`length mismatch: ${rendered.length} vs ${reference.length}`)
    }
    let peak = 0
    let sumSquares = 0
    for (let index = 0; index < rendered.length; index++) {
        const difference = Math.abs(rendered[index] - reference[index])
        if (difference > peak) {
            peak = difference
        }
        sumSquares += difference * difference
    }
    return {peak, rms: Math.sqrt(sumSquares / rendered.length)}
}

type SineExports = {
    memory: WebAssembly.Memory
    init: (sampleRate: number, frequency: number) => void
    process: (frames: number) => void
    out_ptr: () => number
}

/** Deterministic offline render of the sine wasm: N blocks, no AudioContext. */
export const renderSineOffline = async (wasmPath: string, sampleRate: number, frequency: number,
                                        frames: number, blocks: number): Promise<Float32Array> => {
    const module = await WebAssembly.compile(readFileSync(wasmPath))
    const exports = new WebAssembly.Instance(module, {}).exports as unknown as SineExports
    exports.init(sampleRate, frequency)
    const output = new Float32Array(frames * blocks)
    for (let block = 0; block < blocks; block++) {
        exports.process(frames)
        output.set(new Float32Array(exports.memory.buffer, exports.out_ptr(), frames), block * frames)
    }
    return output
}

const round = Math.fround
const PI = round(3.1415927)

// Mirrors dsp::fast_sin (parabolic approximation) in f32 so the reference matches the wasm exactly.
const fastSin = (x: number): number => {
    const b = round(4 / PI)
    const c = round(-4 / (PI * PI))
    const y = round(round(b * x) + round(round(c * x) * round(Math.abs(x))))
    return round(round(0.225 * round(round(y * round(Math.abs(y))) - y)) + y)
}

/** TS reference matching the `sine` crate: 0.2 * fast_sin((phase*2-1)*PI), continuous phase. */
export const referenceSine = (sampleRate: number, frequency: number,
                              frames: number, blocks: number): Float32Array => {
    const increment = round(frequency / sampleRate)
    const output = new Float32Array(frames * blocks)
    let phase = 0
    for (let index = 0; index < output.length; index++) {
        output[index] = round(0.2 * fastSin(round(round(round(phase * 2) - 1) * PI)))
        phase = round(phase + increment)
        if (phase >= 1) {
            phase = round(phase - 1)
        }
    }
    return output
}
