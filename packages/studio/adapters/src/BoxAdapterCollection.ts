import {assert, Func, int, Listeners, SortedSet, Subscription, Terminable, UUID} from "@moises-ai/lib-std"
import {Box, PointerField, PointerHub} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {BoxAdapter} from "./BoxAdapter"

export interface AdapterCollectionListener<ADAPTER extends BoxAdapter> {
    onAdd(adapter: ADAPTER): void
    onRemove(adapter: ADAPTER): void
}

export class BoxAdapterCollection<ADAPTER extends BoxAdapter> implements Terminable {
    readonly #entries: SortedSet<UUID.Bytes, ADAPTER>
    readonly #listeners: Listeners<AdapterCollectionListener<ADAPTER>>
    readonly #subscription: Subscription

    constructor(pointerHub: PointerHub, provider: Func<Box, ADAPTER>, pointers: Pointers) {
        this.#entries = UUID.newSet(adapter => adapter.uuid)
        this.#listeners = new Listeners<AdapterCollectionListener<ADAPTER>>()
        this.#subscription = pointerHub.catchupAndSubscribe({
            onAdded: (pointer: PointerField) => {
                const adapter: ADAPTER = provider(pointer.box)
                const added = this.#entries.add(adapter)
                assert(added, `Could not add ${adapter}`)
                this.#listeners.proxy.onAdd(adapter)
            },
            onRemoved: (pointer: PointerField) => {
                const uuid = pointer.box.address.uuid
                this.#listeners.proxy.onRemove(this.#entries.removeByKey(uuid))
            }
        }, pointers)
    }

    subscribe(listener: AdapterCollectionListener<ADAPTER>): Subscription {return this.#listeners.subscribe(listener)}

    catchupAndSubscribe(listener: AdapterCollectionListener<ADAPTER>): Subscription {
        this.#entries.forEach(adapter => listener.onAdd(adapter))
        return this.subscribe(listener)
    }

    adapters(): ReadonlyArray<ADAPTER> {return this.#entries.values()}
    size(): int {return this.#entries.size()}
    isEmpty(): boolean {return this.size() === 0}

    terminate(): void {
        this.#entries.clear()
        this.#listeners.terminate()
        this.#subscription.terminate()
    }
}