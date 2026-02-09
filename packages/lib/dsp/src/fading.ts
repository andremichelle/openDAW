import {Curve, int, unitValue} from "@opendaw/lib-std"
import {ppqn} from "./ppqn"

export namespace FadingEnvelope {
    /**
     * Fading configuration with durations in PPQN.
     * - `in`: fade-in duration in PPQN from region start
     * - `out`: fade-out duration in PPQN counted from region end (backwards)
     */
    export interface Config {
        readonly in: ppqn
        readonly out: ppqn
        readonly inSlope: unitValue
        readonly outSlope: unitValue
    }

    export const hasFading = (config: Config): boolean => config.in > 0.0 || config.out > 0.0

    export const gainAt = (positionPpqn: ppqn, durationPpqn: ppqn, config: Config): number => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config
        let fadeInGain = 1.0
        let fadeOutGain = 1.0
        if (fadeIn > 0.0 && positionPpqn < fadeIn) {
            fadeInGain = Curve.normalizedAt(positionPpqn / fadeIn, inSlope)
        }
        const fadeOutStart = durationPpqn - fadeOut
        if (fadeOut > 0.0 && positionPpqn > fadeOutStart) {
            const progress = (positionPpqn - fadeOutStart) / fadeOut
            fadeOutGain = 1.0 - Curve.normalizedAt(progress, outSlope)
        }
        return Math.min(fadeInGain, fadeOutGain)
    }

    export const fillGainBuffer = (
        gainBuffer: Float32Array,
        startPpqn: ppqn,
        endPpqn: ppqn,
        durationPpqn: ppqn,
        sampleCount: int,
        config: Config
    ): void => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config
        gainBuffer.fill(1.0, 0, sampleCount)
        if (fadeIn <= 0.0 && fadeOut <= 0.0) {return}
        const fadeOutStart = durationPpqn - fadeOut
        if (startPpqn >= fadeIn && endPpqn <= fadeOutStart) {return}
        const ppqnPerSample = (endPpqn - startPpqn) / sampleCount
        if (fadeIn > 0.0 && startPpqn < fadeIn) {
            const fadeInEnd = Math.min(endPpqn, fadeIn)
            const fadeInEndSample = Math.min(sampleCount, Math.ceil((fadeInEnd - startPpqn) / ppqnPerSample))
            if (fadeInEndSample > 0) {
                const startProgress = startPpqn / fadeIn
                const endProgress = fadeInEnd / fadeIn
                const iterator = Curve.walk(inSlope, fadeInEndSample, startProgress, endProgress)
                for (let i = 0; i < fadeInEndSample; i++) {
                    gainBuffer[i] = iterator.next().value
                }
            }
        }
        if (fadeOut > 0.0 && endPpqn > fadeOutStart) {
            const fadeOutStartPpqn = Math.max(startPpqn, fadeOutStart)
            const fadeOutStartSample = Math.max(0, Math.floor((fadeOutStartPpqn - startPpqn) / ppqnPerSample))
            const steps = sampleCount - fadeOutStartSample
            if (steps > 0) {
                const startProgress = (fadeOutStartPpqn - fadeOutStart) / fadeOut
                const endProgress = (endPpqn - fadeOutStart) / fadeOut
                const iterator = Curve.walk(outSlope, steps, 1.0 - startProgress, 1.0 - endProgress)
                for (let i = fadeOutStartSample; i < sampleCount; i++) {
                    gainBuffer[i] = Math.min(gainBuffer[i], iterator.next().value)
                }
            }
        }
    }
}
