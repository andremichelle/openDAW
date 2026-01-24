import {Curve, int, unitValue} from "@opendaw/lib-std"

export namespace FadingEnvelope {
    export interface Config {
        readonly in: unitValue
        readonly out: unitValue
        readonly inSlope: unitValue
        readonly outSlope: unitValue
    }

    export const gainAt = (normalizedPosition: unitValue, config: Config): number => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config
        let fadeInGain = 1.0
        let fadeOutGain = 1.0
        if (fadeIn > 0.0 && normalizedPosition < fadeIn) {
            fadeInGain = Curve.normalizedAt(normalizedPosition / fadeIn, inSlope)
        }
        if (fadeOut < 1.0 && normalizedPosition > fadeOut) {
            const progress = (normalizedPosition - fadeOut) / (1.0 - fadeOut)
            fadeOutGain = 1.0 - Curve.normalizedAt(progress, outSlope)
        }
        return Math.min(fadeInGain, fadeOutGain)
    }

    export const fillGainBuffer = (
        gainBuffer: Float32Array,
        startNormalized: number,
        endNormalized: number,
        sampleCount: int,
        config: Config
    ): void => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config
        gainBuffer.fill(1.0, 0, sampleCount)
        if (fadeIn <= 0.0 && fadeOut >= 1.0) {return}
        if (startNormalized >= fadeIn && endNormalized <= fadeOut) {return}
        const normalizedPerSample = (endNormalized - startNormalized) / sampleCount
        if (fadeIn > 0.0 && startNormalized < fadeIn) {
            const fadeInEndNorm = Math.min(endNormalized, fadeIn)
            const fadeInEndSample = Math.min(sampleCount, Math.ceil((fadeInEndNorm - startNormalized) / normalizedPerSample))
            if (fadeInEndSample > 0) {
                const startProgress = startNormalized / fadeIn
                const endProgress = fadeInEndNorm / fadeIn
                const iterator = Curve.walk(inSlope, fadeInEndSample, startProgress, endProgress)
                for (let i = 0; i < fadeInEndSample; i++) {
                    gainBuffer[i] = iterator.next().value
                }
            }
        }
        if (fadeOut < 1.0 && endNormalized > fadeOut) {
            const fadeOutStartNorm = Math.max(startNormalized, fadeOut)
            const fadeOutStartSample = Math.max(0, Math.floor((fadeOutStartNorm - startNormalized) / normalizedPerSample))
            const steps = sampleCount - fadeOutStartSample
            if (steps > 0) {
                const startProgress = (fadeOutStartNorm - fadeOut) / (1.0 - fadeOut)
                const endProgress = (endNormalized - fadeOut) / (1.0 - fadeOut)
                const iterator = Curve.walk(outSlope, steps, 1.0 - startProgress, 1.0 - endProgress)
                for (let i = fadeOutStartSample; i < sampleCount; i++) {
                    gainBuffer[i] = Math.min(gainBuffer[i], iterator.next().value)
                }
            }
        }
    }
}
