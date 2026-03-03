import {Notifier, Observer, Option, SortedSet, Subscription, Terminable, unitValue} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter} from "./AutomatableParameterFieldAdapter"

export type ParameterWriteEvent = {
    adapter: AutomatableParameterFieldAdapter
    previousUnitValue: unitValue
}

export class ParameterFieldAdapters {
    readonly #set: SortedSet<Address, AutomatableParameterFieldAdapter>
    readonly #writeNotifier: Notifier<ParameterWriteEvent>

    constructor() {
        this.#set = Address.newSet<AutomatableParameterFieldAdapter>(adapter => adapter.field.address)
        this.#writeNotifier = new Notifier<ParameterWriteEvent>()
    }

    register(adapter: AutomatableParameterFieldAdapter): Terminable {
        this.#set.add(adapter)
        return {terminate: () => this.#set.removeByValue(adapter)}
    }

    get(address: Address): AutomatableParameterFieldAdapter {return this.#set.get(address)}
    opt(address: Address): Option<AutomatableParameterFieldAdapter> {return this.#set.opt(address)}

    subscribeWrites(observer: Observer<ParameterWriteEvent>): Subscription {
        return this.#writeNotifier.subscribe(observer)
    }

    notifyWrite(adapter: AutomatableParameterFieldAdapter, previousUnitValue: unitValue): void {
        this.#writeNotifier.notify({adapter, previousUnitValue})
    }
}