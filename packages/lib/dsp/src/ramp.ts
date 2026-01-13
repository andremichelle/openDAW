import {int} from "@moises-ai/lib-std"
import {StereoMatrix} from "./stereo"
import {Mixing} from "./mixing"

export interface Ramp<T> {
    set(target: T, smooth?: boolean): void
    get(): T
    moveAndGet(): T
    isFixed(value: T): boolean
    isInterpolating(): boolean
}

export namespace Ramp {
    export const linear = (sampleRate: number,
                           durationInSeconds: number = 0.005): LinearRamp => {
        return new LinearRamp(Math.ceil(sampleRate * durationInSeconds) | 0)
    }

    export const stereoMatrix = (sampleRate: number,
                                 durationInSeconds: number = 0.005): StereoMatrixRamp => {
        return new StereoMatrixRamp(Math.ceil(sampleRate * durationInSeconds) | 0)
    }

    class LinearRamp implements Ramp<number> {
        readonly #length: int

        #value = 0.0
        #target = 0.0
        #delta = 0.0
        #remaining: int = 0 | 0

        constructor(length: int) {this.#length = length}

        set(target: number, smooth?: boolean): void {
            if (this.#value === target) {return}
            if (smooth === true) {
                this.#target = target
                this.#delta = (target - this.#value) / this.#length
                this.#remaining = this.#length
            } else {
                this.#value = this.#target = target
                this.#delta = 0.0
                this.#remaining = 0
            }
        }

        get(): number {return this.#value}

        moveAndGet(): number {
            if (0 < this.#remaining) {
                this.#value += this.#delta
                if (0 === --this.#remaining) {
                    this.#delta = 0.0
                    this.#value = this.#target
                }
            }
            return this.#value
        }

        isFixed(value: number): boolean {return this.#value === value && 0 === this.#remaining}
        isInterpolating(): boolean {return this.#remaining > 0}
    }

    export class StereoMatrixRamp implements Ramp<Readonly<StereoMatrix.Matrix>> {
        readonly #length: int

        #value: StereoMatrix.Matrix = StereoMatrix.zero()
        #target: StereoMatrix.Matrix = StereoMatrix.zero()
        #delta: StereoMatrix.Matrix = StereoMatrix.zero()
        #remaining: int = 0 | 0

        constructor(length: int) {this.#length = length}

        update(params: StereoMatrix.Params,
               mixing: Mixing, smooth?: boolean): void {
            StereoMatrix.update(this.#target, params, mixing)
            if (smooth === true) {
                this.#delta.ll = (this.#target.ll - this.#value.ll) / this.#length
                this.#delta.lr = (this.#target.lr - this.#value.lr) / this.#length
                this.#delta.rl = (this.#target.rl - this.#value.rl) / this.#length
                this.#delta.rr = (this.#target.rr - this.#value.rr) / this.#length
                this.#remaining = this.#length
            } else {
                this.#value.ll = this.#target.ll
                this.#value.lr = this.#target.lr
                this.#value.rl = this.#target.rl
                this.#value.rr = this.#target.rr
                this.#delta.ll = 0.0
                this.#delta.lr = 0.0
                this.#delta.rl = 0.0
                this.#delta.rr = 0.0
                this.#remaining = 0
            }
        }

        processFrames(source: StereoMatrix.Channels, target: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
            const [src0, src1] = source
            const [trg0, trg1] = target
            if (this.isInterpolating()) {
                for (let i = fromIndex; i < toIndex; i++) {
                    const l = src0[i]
                    const r = src1[i]
                    const m = this.moveAndGet()
                    trg0[i] = m.ll * l + m.rl * r
                    trg1[i] = m.lr * l + m.rr * r
                }
            } else {
                const m = this.#target
                for (let i = fromIndex; i < toIndex; i++) {
                    const l = src0[i]
                    const r = src1[i]
                    trg0[i] = m.ll * l + m.rl * r
                    trg1[i] = m.lr * l + m.rr * r
                }
            }
        }

        set(target: Readonly<StereoMatrix.Matrix>, smooth?: boolean): void {
            if (this.#equals(target)) {return}
            if (smooth === true) {
                this.#target.ll = target.ll
                this.#target.lr = target.lr
                this.#target.rl = target.rl
                this.#target.rr = target.rr
                this.#delta.ll = (target.ll - this.#value.ll) / this.#length
                this.#delta.lr = (target.lr - this.#value.lr) / this.#length
                this.#delta.rl = (target.rl - this.#value.rl) / this.#length
                this.#delta.rr = (target.rr - this.#value.rr) / this.#length
                this.#remaining = this.#length
            } else {
                this.#value.ll = this.#target.ll = target.ll
                this.#value.lr = this.#target.lr = target.lr
                this.#value.rl = this.#target.rl = target.rl
                this.#value.rr = this.#target.rr = target.rr
                this.#delta.ll = 0.0
                this.#delta.lr = 0.0
                this.#delta.rl = 0.0
                this.#delta.rr = 0.0
                this.#remaining = 0
            }
        }

        get(): Readonly<StereoMatrix.Matrix> {return this.#value}

        moveAndGet(): Readonly<StereoMatrix.Matrix> {
            if (0 < this.#remaining) {
                this.#value.ll += this.#delta.ll
                this.#value.lr += this.#delta.lr
                this.#value.rl += this.#delta.rl
                this.#value.rr += this.#delta.rr
                if (0 === --this.#remaining) {
                    this.#delta.ll = 0.0
                    this.#delta.lr = 0.0
                    this.#delta.rl = 0.0
                    this.#delta.rr = 0.0
                    this.#value.ll = this.#target.ll
                    this.#value.lr = this.#target.lr
                    this.#value.rl = this.#target.rl
                    this.#value.rr = this.#target.rr
                }
            }
            return this.#value
        }

        isFixed(value: Readonly<StereoMatrix.Matrix>): boolean {return this.#equals(value) && this.#remaining === 0}

        isInterpolating(): boolean {return this.#remaining > 0}

        #equals(value: Readonly<StereoMatrix.Matrix>): boolean {
            return this.#value.ll === value.ll && this.#value.lr === value.lr
                && this.#value.rl === value.rl && this.#value.rr === value.rr
        }
    }
}