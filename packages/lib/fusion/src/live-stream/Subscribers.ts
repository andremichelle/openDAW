import {Arrays, isDefined, Maybe, SortedSet, Subscription, Terminable} from "@moises-ai/lib-std"
import {Address} from "@moises-ai/lib-box"

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
                this.#subscribers.opt(address).ifSome(entry => {
                    Arrays.remove(entry.listeners, listener)
                    if (entry.listeners.length === 0) {
                        this.#subscribers.removeByKey(address)
                    }
                })
            }
        }
    }

    terminate(): void {this.#subscribers.clear()}
}