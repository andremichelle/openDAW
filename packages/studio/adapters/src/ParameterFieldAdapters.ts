import {Notifier, Observer, Option, SortedSet, Subscription, Terminable, unitValue} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {AutomatableParameterFieldAdapter} from "./AutomatableParameterFieldAdapter"
import {ParameterTracks} from "./timeline/ParameterTracks"

export type AutomationMode = "read" | "touch" | "latch"

export type ParameterWriteEvent = {
    adapter: AutomatableParameterFieldAdapter
    previousUnitValue: unitValue
}

export class ParameterFieldAdapters {
    readonly #set: SortedSet<Address, AutomatableParameterFieldAdapter>
    readonly #writeNotifier: Notifier<ParameterWriteEvent>
    readonly #tracksMap: Map<string, ParameterTracks>
    readonly #modeMap: Map<string, AutomationMode>

    constructor() {
        this.#set = Address.newSet<AutomatableParameterFieldAdapter>(adapter => adapter.field.address)
        this.#writeNotifier = new Notifier<ParameterWriteEvent>()
        this.#tracksMap = new Map()
        this.#modeMap = new Map()
    }

    register(adapter: AutomatableParameterFieldAdapter): Terminable {
        this.#set.add(adapter)
        return {terminate: () => this.#set.removeByValue(adapter)}
    }

    get(address: Address): AutomatableParameterFieldAdapter {return this.#set.get(address, "parameter field adapter")}
    opt(address: Address): Option<AutomatableParameterFieldAdapter> {return this.#set.opt(address)}

    registerTracks(address: Address, tracks: ParameterTracks): Terminable {
        const key = address.toString()
        this.#tracksMap.set(key, tracks)
        return {terminate: () => this.#tracksMap.delete(key)}
    }

    getTracks(address: Address): Option<ParameterTracks> {
        return Option.wrap(this.#tracksMap.get(address.toString()))
    }

    setMode(address: Address, mode: AutomationMode): void {this.#modeMap.set(address.toString(), mode)}
    getMode(address: Address): AutomationMode {return this.#modeMap.get(address.toString()) ?? "read"}

    subscribeWrites(observer: Observer<ParameterWriteEvent>): Subscription {
        return this.#writeNotifier.subscribe(observer)
    }

    notifyWrite(adapter: AutomatableParameterFieldAdapter, previousUnitValue: unitValue): void {
        this.#writeNotifier.notify({adapter, previousUnitValue})
    }
}