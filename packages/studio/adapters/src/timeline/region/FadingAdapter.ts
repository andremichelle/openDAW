import {Fading} from "@opendaw/studio-boxes"
import {FadingEnvelope, ppqn} from "@opendaw/lib-dsp"
import {MutableObservableValue, unitValue} from "@opendaw/lib-std"

export class FadingAdapter implements FadingEnvelope.Config {
    readonly #fading: Fading
    constructor(fading: Fading) {this.#fading = fading}
    get inField(): MutableObservableValue<number> {return this.#fading.in}
    get outField(): MutableObservableValue<number> {return this.#fading.out}
    get inSlopeField(): MutableObservableValue<number> {return this.#fading.inSlope}
    get outSlopeField(): MutableObservableValue<number> {return this.#fading.outSlope}
    get in(): ppqn {return this.#fading.in.getValue()}
    get out(): ppqn {return this.#fading.out.getValue()}
    get inSlope(): unitValue {return this.#fading.inSlope.getValue()}
    get outSlope(): unitValue {return this.#fading.outSlope.getValue()}
    get hasFading(): boolean {return FadingEnvelope.hasFading(this)}
    copyTo(target: Fading): void {
        target.in.setValue(this.in)
        target.out.setValue(this.out)
        target.inSlope.setValue(this.inSlope)
        target.outSlope.setValue(this.outSlope)
    }
    reset(): void {
        this.#fading.in.setValue(0.0)
        this.#fading.out.setValue(0.0)
        this.#fading.inSlope.setValue(0.75)
        this.#fading.outSlope.setValue(0.25)
    }
}
