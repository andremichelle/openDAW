import {ObservableValue, StringMapping, unitValue, ValueMapping} from "@moises-ai/lib-std"
import {PrimitiveValues} from "@moises-ai/lib-box"

export interface ValueContext {
    readonly anchorModel: ObservableValue<unitValue>
    readonly valueMapping: ValueMapping<PrimitiveValues>
    readonly stringMapping: StringMapping<PrimitiveValues>
    readonly currentValue: unitValue
    readonly floating: boolean
    quantize(value: unitValue): unitValue
}