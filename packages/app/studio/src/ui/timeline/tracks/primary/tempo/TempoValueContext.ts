import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"
import {ObservableValue, StringMapping, ValueMapping} from "@opendaw/lib-std"
import {TempoRange, TimelineBoxAdapter} from "@opendaw/studio-adapters"

export class TempoValueContext implements ValueContext {
    readonly #adapter: TimelineBoxAdapter

    readonly anchorModel: ObservableValue<number> = ObservableValue.seal(0)
    readonly stringMapping: StringMapping<number> = StringMapping.numeric({unit: "bpm", fractionDigits: 1})
    readonly valueMapping: ValueMapping<number> = ValueMapping.exponential(TempoRange.min, TempoRange.max)
    readonly floating: boolean = true

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter
    }

    get currentValue(): number {return this.#adapter.box.bpm.getValue()}

    quantize(value: number): number {return value}
}