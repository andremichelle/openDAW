import {Notifier, Observer, Option, SortedSet, Subscription, Terminable} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter} from "./AutomatableParameterFieldAdapter"

export class ParameterFieldAdapters {
    readonly #set: SortedSet<Address, AutomatableParameterFieldAdapter>
    readonly #writeNotifier: Notifier<AutomatableParameterFieldAdapter>

    constructor() {
        this.#set = Address.newSet<AutomatableParameterFieldAdapter>(adapter => adapter.field.address)
        this.#writeNotifier = new Notifier<AutomatableParameterFieldAdapter>()
    }

    register(adapter: AutomatableParameterFieldAdapter): Terminable {
        this.#set.add(adapter)
        return {terminate: () => this.#set.removeByValue(adapter)}
    }

    get(address: Address): AutomatableParameterFieldAdapter {return this.#set.get(address)}
    opt(address: Address): Option<AutomatableParameterFieldAdapter> {return this.#set.opt(address)}

    subscribeWrites(observer: Observer<AutomatableParameterFieldAdapter>): Subscription {
        return this.#writeNotifier.subscribe(observer)
    }

    notifyWrite(adapter: AutomatableParameterFieldAdapter): void {
        this.#writeNotifier.notify(adapter)
    }
}