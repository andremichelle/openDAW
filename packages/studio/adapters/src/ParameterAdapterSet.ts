import {Address, PointerTypes, PrimitiveField, PrimitiveValues} from "@moises-ai/lib-box"
import {assert, SortedSet, StringMapping, Terminable, unitValue, ValueMapping} from "@moises-ai/lib-std"
import {AutomatableParameterFieldAdapter} from "./AutomatableParameterFieldAdapter"

import {BoxAdaptersContext} from "./BoxAdaptersContext"

export class ParameterAdapterSet implements Terminable {
    readonly #context: BoxAdaptersContext
    readonly #parameters: SortedSet<Address, AutomatableParameterFieldAdapter>

    constructor(context: BoxAdaptersContext) {
        this.#context = context
        this.#parameters = Address.newSet(adapter => adapter.address)
    }

    terminate(): void {
        this.#parameters.forEach(parameter => parameter.terminate())
        this.#parameters.clear()
    }

    parameters(): ReadonlyArray<AutomatableParameterFieldAdapter> {return this.#parameters.values()}
    parameterAt(address: Address): AutomatableParameterFieldAdapter {
        return this.#parameters.getOrThrow(address,
            () => new Error(`No ParameterAdapter found at [${address.toString()}]`))
    }

    createParameter<T extends PrimitiveValues>(field: PrimitiveField<T, PointerTypes>,
                                               valueMapping: ValueMapping<T>,
                                               stringMapping: StringMapping<T>,
                                               name: string,
                                               anchor?: unitValue): AutomatableParameterFieldAdapter<T> {
        const adapter = new AutomatableParameterFieldAdapter<T>(
            this.#context, field, valueMapping, stringMapping, name, anchor)
        const added = this.#parameters.add(adapter)
        assert(added, `Could not add adapter for ${field}`)
        return adapter
    }

    removeParameter<T extends PrimitiveValues>(address: Address): AutomatableParameterFieldAdapter<T> {
        return this.#parameters.removeByKey(address)
    }
}