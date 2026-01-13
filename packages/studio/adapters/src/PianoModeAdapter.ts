import {PianoMode} from "@moises-ai/studio-boxes"
import {float, int, Observer, StringMapping, Subscription, ValueMapping} from "@moises-ai/lib-std"
import {FieldAdapter} from "./FieldAdapter"
import {Propagation} from "@moises-ai/lib-box"

export class PianoModeAdapter {
    readonly #object: PianoMode

    readonly #keyboard: FieldAdapter<int>
    readonly #timeRangeInQuarters: FieldAdapter<float>
    readonly #noteScale: FieldAdapter<float>
    readonly #noteLabels: FieldAdapter<boolean>
    readonly #transpose: FieldAdapter<int>

    constructor(object: PianoMode) {
        this.#object = object

        this.#keyboard = new FieldAdapter(
            this.#object.keyboard,
            ValueMapping.values([88, 76, 61, 49]),
            StringMapping.numeric({fractionDigits: 1}), "Keyboard Type")

        this.#timeRangeInQuarters = new FieldAdapter(
            this.#object.timeRangeInQuarters,
            ValueMapping.exponential(1, 64),
            StringMapping.numeric({fractionDigits: 1}), "Time-Range")

        this.#noteScale = new FieldAdapter(
            this.#object.noteScale,
            ValueMapping.exponential(0.5, 2.0),
            StringMapping.numeric({fractionDigits: 1}), "Note Scale")

        this.#noteLabels = new FieldAdapter(
            this.#object.noteLabels, ValueMapping.bool, StringMapping.bool, "Note Labels")

        this.#transpose = new FieldAdapter(
            this.#object.transpose,
            ValueMapping.linearInteger(-48, 48),
            StringMapping.numeric({fractionDigits: 0}), "Transpose")
    }

    subscribe(observer: Observer<this>): Subscription {
        return this.#object.box.subscribe(Propagation.Children, () => observer(this))
    }

    get object(): PianoMode {return this.#object}

    get keyboard(): FieldAdapter<int> {return this.#keyboard}
    get timeRangeInQuarters(): FieldAdapter<float> {return this.#timeRangeInQuarters}
    get noteScale(): FieldAdapter<float> {return this.#noteScale}
    get noteLabels(): FieldAdapter<boolean> {return this.#noteLabels}
    get transpose(): FieldAdapter<int> {return this.#transpose}
}