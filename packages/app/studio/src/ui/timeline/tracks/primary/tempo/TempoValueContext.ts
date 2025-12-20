import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"
import {ObservableValue, StringMapping, ValueMapping} from "@opendaw/lib-std"
import {TimelineBoxAdapter} from "@opendaw/studio-adapters"

export class TempoValueContext implements ValueContext {
    // @ts-ignore
    readonly #adapter: TimelineBoxAdapter

    readonly anchorModel: ObservableValue<number> = ObservableValue.seal(0)
    readonly stringMapping: StringMapping<number> = StringMapping.numeric({unit: "bpm", fractionDigits: 1})
    readonly valueMapping: ValueMapping<number> = ValueMapping.unipolar()//linear(TempoRange.min, TempoRange.max)
    readonly floating: boolean = true

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter
    }

    get currentValue(): number {
        return 0.0 // TODO
    }

    quantize(value: number): number {
        return value
    }
}