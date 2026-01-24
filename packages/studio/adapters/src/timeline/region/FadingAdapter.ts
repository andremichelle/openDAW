import {Fading} from "@opendaw/studio-boxes"
import {FadingEnvelope} from "@opendaw/lib-dsp"
import {int, MutableObservableValue, unitValue} from "@opendaw/lib-std"

export class FadingAdapter implements FadingEnvelope.Config {
    readonly #fading: Fading
    constructor(fading: Fading) {this.#fading = fading}
    get inField(): MutableObservableValue<number> {return this.#fading.in}
    get outField(): MutableObservableValue<number> {return this.#fading.out}
    get inSlopeField(): MutableObservableValue<number> {return this.#fading.inSlope}
    get outSlopeField(): MutableObservableValue<number> {return this.#fading.outSlope}
    get in(): unitValue {return this.#fading.in.getValue()}
    get out(): unitValue {return this.#fading.out.getValue()}
    get inSlope(): unitValue {return this.#fading.inSlope.getValue()}
    get outSlope(): unitValue {return this.#fading.outSlope.getValue()}
    get hasFading(): boolean {return this.in > 0.0 || this.out < 1.0}
    gainAt(normalizedPosition: unitValue): number {return FadingEnvelope.gainAt(normalizedPosition, this)}
    fillGainBuffer(gainBuffer: Float32Array, startNormalized: number, endNormalized: number, sampleCount: int): void {
        FadingEnvelope.fillGainBuffer(gainBuffer, startNormalized, endNormalized, sampleCount, this)
    }
    copyTo(target: Fading): void {
        target.in.setValue(this.in)
        target.out.setValue(this.out)
        target.inSlope.setValue(this.inSlope)
        target.outSlope.setValue(this.outSlope)
    }
    reset(): void {
        this.#fading.in.setValue(0.0)
        this.#fading.out.setValue(1.0)
        this.#fading.inSlope.setValue(0.5)
        this.#fading.outSlope.setValue(0.5)
    }
}
