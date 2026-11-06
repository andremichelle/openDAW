import {HOP, OVERLAP, SEGMENT_LENGTH} from "./Constants"

export type Segment = {
    readonly data: Float32Array
    readonly startSample: number
    readonly isLast: boolean
    readonly padSamples: number
}

export type Chunked = {
    readonly segments: ReadonlyArray<Segment>
    readonly totalSamples: number
}

export const chunkStereo = (left: Float32Array, right: Float32Array): Chunked => {
    const totalSamples = left.length
    const count = Math.max(1, Math.ceil((totalSamples - OVERLAP) / HOP))
    const segments: Array<Segment> = []
    for (let i = 0; i < count; i++) {
        const start = i * HOP
        const data = new Float32Array(2 * SEGMENT_LENGTH)
        const copyLen = Math.max(0, Math.min(SEGMENT_LENGTH, totalSamples - start))
        if (copyLen > 0) {
            data.set(left.subarray(start, start + copyLen), 0)
            data.set(right.subarray(start, start + copyLen), SEGMENT_LENGTH)
        }
        const padSamples = SEGMENT_LENGTH - copyLen
        segments.push({data, startSample: start, isLast: i === count - 1, padSamples})
    }
    return {segments, totalSamples}
}

export const buildTriangularWeights = (): Float32Array => {
    const weights = new Float32Array(SEGMENT_LENGTH)
    for (let k = 0; k < SEGMENT_LENGTH; k++) {
        if (k < OVERLAP) {
            weights[k] = (k + 1) / OVERLAP
        } else if (k >= SEGMENT_LENGTH - OVERLAP) {
            weights[k] = (SEGMENT_LENGTH - k) / OVERLAP
        } else {
            weights[k] = 1.0
        }
    }
    return weights
}
