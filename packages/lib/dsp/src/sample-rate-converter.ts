import {int} from "@opendaw/lib-std"

export namespace SampleRateConverter {
    export const convert = (
        source: Float32Array,
        sourceSampleRate: number,
        targetSampleRate: number
    ): Float32Array => {
        if (source.length === 0) {
            return new Float32Array(0)
        }

        if (sourceSampleRate === targetSampleRate) {
            return source.slice()
        }

        const ratio = sourceSampleRate / targetSampleRate
        const targetLength = Math.max(1, Math.floor(source.length / ratio))
        const target = new Float32Array(targetLength)

        for (let i: int = 0; i < targetLength; i++) {
            const srcPos = i * ratio
            const srcIndex = Math.floor(srcPos)
            const frac = srcPos - srcIndex

            const s0 = source[srcIndex]
            const s1 = source[Math.min(srcIndex + 1, source.length - 1)]
            target[i] = s0 + frac * (s1 - s0)
        }

        return target
    }

    export const calculateOutputLength = (
        sourceLength: int,
        sourceSampleRate: number,
        targetSampleRate: number
    ): int => {
        if (sourceLength === 0) {
            return 0
        }
        const ratio = sourceSampleRate / targetSampleRate
        return Math.max(1, Math.floor(sourceLength / ratio))
    }
}
