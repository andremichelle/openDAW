import {Arrays, isDefined, Maybe, SortedSet, Subscription, Terminable} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"

type ListenersEntry<T> = { address: Address, listeners: Array<T> }

export class Subscribers<T> implements Terminable {
    readonly #subscribers: SortedSet<Address, ListenersEntry<T>>

    constructor() {this.#subscribers = Address.newSet<ListenersEntry<T>>(entry => entry.address)}

    getOrNull(address: Address): Maybe<ReadonlyArray<T>> {return this.#subscribers.getOrNull(address)?.listeners}

    isEmpty(address: Address): boolean {return !this.#subscribers.hasKey(address) }

    subscribe(address: Address, listener: T): Subscription {
        const entry = this.#subscribers.getOrNull(address)
        if (isDefined(entry)) {
            entry.listeners.push(listener)
        } else {
            this.#subscribers.add({address, listeners: [listener]})
        }
        return {
            terminate: () => {
                const entry = this.#subscribers.removeByKeyIfExist(address)
                if (isDefined(entry)) {
                    Arrays.removeOpt(entry.listeners, listener)
                    if (entry.listeners.length > 0) {
                        this.#subscribers.add(entry)
                    }
                }
            }
        }
    }

    terminate(): void {this.#subscribers.clear()}
}