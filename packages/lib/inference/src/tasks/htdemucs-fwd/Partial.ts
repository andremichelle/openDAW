export interface PartialStemResult {
    readonly fromSample: number
    readonly toSample: number
    readonly channels: 1 | 2
    readonly sampleRate: number
    readonly drums: Float32Array
    readonly bass: Float32Array
    readonly other: Float32Array
    readonly vocals: Float32Array
}

type StemBuffers = readonly [left: Float32Array, right: Float32Array]

const toPlanarRange = (buffers: StemBuffers, channels: 1 | 2, fromSample: number, toSample: number): Float32Array => {
    const [left, right] = buffers
    const length = toSample - fromSample
    if (channels === 1) {
        const mono = new Float32Array(length)
        for (let i = 0; i < length; i++) {mono[i] = (left[fromSample + i] + right[fromSample + i]) * 0.5}
        return mono
    }
    const planar = new Float32Array(2 * length)
    planar.set(left.subarray(fromSample, toSample), 0)
    planar.set(right.subarray(fromSample, toSample), length)
    return planar
}

export const buildPartial = (
    stemBuffers: Record<string, StemBuffers>,
    channels: 1 | 2,
    sampleRate: number,
    fromSample: number,
    toSample: number
): PartialStemResult => ({
    fromSample, toSample, channels, sampleRate,
    drums:  toPlanarRange(stemBuffers.drums, channels, fromSample, toSample),
    bass:   toPlanarRange(stemBuffers.bass, channels, fromSample, toSample),
    other:  toPlanarRange(stemBuffers.other, channels, fromSample, toSample),
    vocals: toPlanarRange(stemBuffers.vocals, channels, fromSample, toSample)
})
