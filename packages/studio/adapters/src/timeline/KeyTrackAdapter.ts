import {assert, Notifier, Observer, SortedSet, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {EventCollection, Harmony, ppqn} from "@opendaw/lib-dsp"
import {KeyEventBox, KeyTrack} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {KeyEventBoxAdapter} from "./KeyEventBoxAdapter"

export class KeyTrackAdapter implements Terminable {
    readonly #terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #object: KeyTrack
    readonly #notifier: Notifier<void>
    readonly #adapters: SortedSet<UUID.Bytes, KeyEventBoxAdapter>
    readonly #events: EventCollection<KeyEventBoxAdapter>

    constructor(context: BoxAdaptersContext, object: KeyTrack) {
        this.#context = context
        this.#object = object
        this.#notifier = new Notifier<void>()
        this.#adapters = UUID.newSet<KeyEventBoxAdapter>(adapter => adapter.uuid)
        this.#events = EventCollection.create(KeyEventBoxAdapter.Comparator)
        this.#terminator.ownAll(
            this.#object.events.pointerHub.catchupAndSubscribe({
                onAdded: ({box}) => {
                    if (box instanceof KeyEventBox) {
                        const adapter = this.#context.boxAdapters.adapterFor(box, KeyEventBoxAdapter)
                        assert(this.#adapters.add(adapter), "Could not add adapter")
                        this.#events.add(adapter)
                        this.dispatchChange()
                    }
                },
                onRemoved: ({box: {address: {uuid}}}) => {
                    this.#events.remove(this.#adapters.removeByKey(uuid))
                    this.dispatchChange()
                }
            }),
            this.#object.enabled.subscribe(() => this.dispatchChange()),
            this.#object.root.subscribe(() => this.dispatchChange()),
            this.#object.scale.subscribe(() => this.dispatchChange())
        )
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#object.enabled.getValue()}
    get events(): EventCollection<KeyEventBoxAdapter> {return this.#events}
    get object(): KeyTrack {return this.#object}
    get storageKey(): Harmony.Key {return {root: this.#object.root.getValue(), bits: this.#object.scale.getValue()}}

    keyAt(position: ppqn): Harmony.Key {
        if (!this.enabled) {return this.storageKey}
        return this.#events.lowerEqual(position)?.key ?? this.storageKey
    }

    /** @internal */
    dispatchChange(): void {this.#notifier.notify()}

    onSortingChanged(): void {
        this.#events.onIndexingChanged()
        this.dispatchChange()
    }

    terminate(): void {this.#terminator.terminate()}
}
