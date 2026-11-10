import {int} from "@opendaw/lib-std"

export class SilenceTail {
    readonly #threshold: number
    readonly #framesNeeded: int
    readonly #minFrames: number
    readonly #keepFrames: int
    #silentFrames: int = 0
    #hasHadAudio: boolean = false
    #totalFrames: int = 0

    constructor(threshold: number, framesNeeded: int, minFrames: number, keepFrames: int) {
        this.#threshold = threshold
        this.#framesNeeded = framesNeeded
        this.#minFrames = minFrames
        this.#keepFrames = keepFrames
    }

    accept(channels: ReadonlyArray<Float32Array>): boolean {
        let maxSample = 0
        for (const channel of channels) {
            for (const sample of channel) {
                const absoluteValue = Math.abs(sample)
                if (absoluteValue > maxSample) {maxSample = absoluteValue}
            }
        }
        if (maxSample > this.#threshold) {
            this.#hasHadAudio = true
            this.#silentFrames = 0
        } else if (this.#hasHadAudio) {
            const silentFrames = this.#silentFrames + channels[0].length
            if (silentFrames >= this.#framesNeeded && this.#totalFrames >= this.#minFrames) {return false}
            this.#silentFrames = silentFrames
        }
        this.#totalFrames += channels[0].length
        return true
    }

    get framesToKeep(): int {
        return this.#totalFrames - this.#silentFrames + Math.min(this.#keepFrames, this.#silentFrames)
    }
}
