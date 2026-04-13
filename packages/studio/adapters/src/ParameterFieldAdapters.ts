import {Notifier, Observer, Option, SortedSet, Subscription, Terminable, unitValue} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"
import {AutomatableParameterFieldAdapter} from "./AutomatableParameterFieldAdapter"
import {AudioUnitTracks} from "./audio-unit/AudioUnitTracks"

export type AutomationMode = "read" | "touch" | "latch"

export type ParameterWriteEvent = {
    adapter: AutomatableParameterFieldAdapter
    previousUnitValue: unitValue
}

export class ParameterFieldAdapters {
    readonly #set: SortedSet<Address, AutomatableParameterFieldAdapter>
    readonly #writeNotifier: Notifier<ParameterWriteEvent>
    readonly #tracksMap: Map<string, AudioUnitTracks>
    readonly #touchedSet: Set<string>
    readonly #touchEndNotifier: Notifier<Address>
    readonly #modeMap: Map<string, AutomationMode>

    constructor() {
        this.#set = Address.newSet<AutomatableParameterFieldAdapter>(adapter => adapter.field.address)
        this.#writeNotifier = new Notifier<ParameterWriteEvent>()
        this.#tracksMap = new Map()
        this.#touchedSet = new Set()
        this.#touchEndNotifier = new Notifier<Address>()
        this.#modeMap = new Map()
    }

    register(adapter: AutomatableParameterFieldAdapter): Terminable {
        this.#set.add(adapter)
        return {terminate: () => this.#set.removeByValue(adapter)}
    }

    get(address: Address): AutomatableParameterFieldAdapter {return this.#set.get(address)}
    opt(address: Address): Option<AutomatableParameterFieldAdapter> {return this.#set.opt(address)}

    registerTracks(address: Address, tracks: AudioUnitTracks): Terminable {
        const key = address.toString()
        this.#tracksMap.set(key, tracks)
        return {terminate: () => this.#tracksMap.delete(key)}
    }

    getTracks(address: Address): Option<AudioUnitTracks> {
        return Option.wrap(this.#tracksMap.get(address.toString()))
    }

    setMode(address: Address, mode: AutomationMode): void {this.#modeMap.set(address.toString(), mode)}
    getMode(address: Address): AutomationMode {return this.#modeMap.get(address.toString()) ?? "read"}

    touchStart(address: Address): void {this.#touchedSet.add(address.toString())}
    touchEnd(address: Address): void {
        const key = address.toString()
        if (this.#touchedSet.delete(key)) {this.#touchEndNotifier.notify(address)}
    }
    isTouched(address: Address): boolean {return this.#touchedSet.has(address.toString())}
    subscribeTouchEnd(observer: Observer<Address>): Subscription {return this.#touchEndNotifier.subscribe(observer)}

    subscribeWrites(observer: Observer<ParameterWriteEvent>): Subscription {
        return this.#writeNotifier.subscribe(observer)
    }

    notifyWrite(adapter: AutomatableParameterFieldAdapter, previousUnitValue: unitValue): void {
        this.#writeNotifier.notify({adapter, previousUnitValue})
    }
}