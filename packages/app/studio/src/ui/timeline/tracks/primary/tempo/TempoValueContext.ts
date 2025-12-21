import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"
import {
    clamp,
    MutableObservableValue,
    ObservableValue,
    StringMapping,
    Terminable,
    Terminator,
    unitValue,
    ValueMapping
} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "@opendaw/studio-adapters"
import {bpm} from "@opendaw/lib-dsp"

export class TempoValueContext implements ValueContext, Terminable {
    readonly #terminator = new Terminator()
    readonly #adapter: TimelineBoxAdapter

    readonly anchorModel: ObservableValue<number> = ObservableValue.seal(0)
    readonly stringMapping: StringMapping<number> = StringMapping.numeric({unit: "bpm", fractionDigits: 1})
    readonly valueMapping: ValueMapping<number>
    readonly floating: boolean = true

    readonly #min: MutableObservableValue<bpm>
    readonly #max: MutableObservableValue<bpm>

    constructor(adapter: TimelineBoxAdapter, [min, max]: [MutableObservableValue<bpm>, MutableObservableValue<bpm>]) {
        this.#adapter = adapter

        this.#min = min
        this.#max = max

        this.valueMapping = {
            x: (y: number): unitValue => {
                const min = this.#min.getValue()
                const max = this.#max.getValue()
                return Math.log(y / min) / Math.log(max / min)
            },
            y: (x: unitValue): number => {
                const min = this.#min.getValue()
                const max = this.#max.getValue()
                return Math.exp(x * Math.log(max / min)) * min
            },
            clamp: (y: number): number => clamp(y, this.#min.getValue(), this.#max.getValue()),
            floating: (): boolean => true
        }
    }

    get currentValue(): number {return this.#adapter.box.bpm.getValue()}

    quantize(value: number): number {return value}

    terminate(): void {this.#terminator.terminate()}
}