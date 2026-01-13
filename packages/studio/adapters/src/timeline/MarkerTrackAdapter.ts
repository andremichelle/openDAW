import {assert, Notifier, Observer, SortedSet, Subscription, Terminable, UUID} from "@moises-ai/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {EventCollection} from "@moises-ai/lib-dsp"
import {MarkerBoxAdapter} from "./MarkerBoxAdapter"
import {MarkerBox, MarkerTrack} from "@moises-ai/studio-boxes"

export class MarkerTrackAdapter implements Terminable {
    readonly #context: BoxAdaptersContext
    readonly #object: MarkerTrack

    readonly changeNotifier: Notifier<void>
    readonly #adapters: SortedSet<UUID.Bytes, MarkerBoxAdapter>
    readonly #events: EventCollection<MarkerBoxAdapter>
    readonly #subscription: Subscription

    constructor(context: BoxAdaptersContext, object: MarkerTrack) {
        this.#context = context
        this.#object = object

        this.changeNotifier = new Notifier<void>()
        this.#adapters = UUID.newSet<MarkerBoxAdapter>(adapter => adapter.uuid)
        this.#events = EventCollection.create(MarkerBoxAdapter.Comparator)

        this.#subscription = this.#object.markers.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                if (box instanceof MarkerBox) {
                    const adapter = this.#context.boxAdapters.adapterFor(box, MarkerBoxAdapter)
                    const added = this.#adapters.add(adapter)
                    assert(added, "Could not add adapter")
                    this.#events.add(adapter)
                    this.dispatchChange()
                }
            },
            onRemoved: ({box: {address: {uuid}}}) => {
                this.#events.remove(this.#adapters.removeByKey(uuid))
                this.dispatchChange()
            }
        })
    }

    subscribe(observer: Observer<void>): Subscription {return this.changeNotifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#object.enabled.getValue()}
    get events(): EventCollection<MarkerBoxAdapter> {return this.#events}
    get object(): MarkerTrack {return this.#object}

    dispatchChange(): void {this.changeNotifier.notify()}

    onSortingChanged(): void {
        this.#events.onIndexingChanged()
        this.dispatchChange()
    }

    terminate(): void {this.#subscription.terminate()}
}