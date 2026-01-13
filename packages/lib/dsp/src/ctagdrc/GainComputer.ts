import {int} from "@moises-ai/lib-std"
import {gainToDecibels} from "./conversation"

export class GainComputer {
    #threshold: number = -20.0
    #ratio: number = 2.0
    #knee: number = 6.0
    #kneeHalf: number = 3.0
    #slope: number = -0.5

    setThreshold(newThreshold: number): void {
        this.#threshold = newThreshold
    }

    setRatio(newRatio: number): void {
        if (this.#ratio !== newRatio) {
            this.#ratio = newRatio
            if (this.#ratio > 23.9) {
                this.#ratio = -Infinity
            }
            this.#slope = 1.0 / newRatio - 1.0
        }
    }

    setKnee(newKnee: number): void {
        if (newKnee !== this.#knee) {
            this.#knee = newKnee
            this.#kneeHalf = newKnee / 2.0
        }
    }

    applyCompression(input: number): number {
        const overshoot = input - this.#threshold
        if (overshoot <= -this.#kneeHalf) {
            return 0.0
        }
        if (overshoot > -this.#kneeHalf && overshoot <= this.#kneeHalf) {
            return 0.5 * this.#slope * ((overshoot + this.#kneeHalf) * (overshoot + this.#kneeHalf)) / this.#knee
        }
        return this.#slope * overshoot
    }

    applyCompressionToBuffer(src: Float32Array, fromIndex: int, toIndex: int): void {
        for (let i = fromIndex; i < toIndex; ++i) {
            const level = Math.max(Math.abs(src[i]), 1e-6)
            const levelInDecibels = gainToDecibels(level)
            src[i] = this.applyCompression(levelInDecibels)
        }
    }
}