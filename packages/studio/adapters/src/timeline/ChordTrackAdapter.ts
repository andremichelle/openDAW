import {assert, isDefined, Notifier, Nullable, Observer, Option, SortedSet, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {EventCollection, Harmony, ppqn} from "@opendaw/lib-dsp"
import {ChordEventBox, ChordTrack} from "@opendaw/studio-boxes"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ChordEventBoxAdapter} from "./ChordEventBoxAdapter"
import {KeyTrackAdapter} from "./KeyTrackAdapter"

export class ChordTrackAdapter implements Terminable {
    readonly #terminator = new Terminator()
    readonly #context: BoxAdaptersContext
    readonly #object: ChordTrack
    readonly #keyTrack: KeyTrackAdapter
    readonly #notifier: Notifier<void>
    readonly #adapters: SortedSet<UUID.Bytes, ChordEventBoxAdapter>
    readonly #events: EventCollection<ChordEventBoxAdapter>

    constructor(context: BoxAdaptersContext, object: ChordTrack, keyTrack: KeyTrackAdapter) {
        this.#context = context
        this.#object = object
        this.#keyTrack = keyTrack
        this.#notifier = new Notifier<void>()
        this.#adapters = UUID.newSet<ChordEventBoxAdapter>(adapter => adapter.uuid)
        this.#events = EventCollection.create(ChordEventBoxAdapter.Comparator)
        this.#terminator.ownAll(
            this.#object.events.pointerHub.catchupAndSubscribe({
                onAdded: ({box}) => {
                    if (box instanceof ChordEventBox) {
                        const adapter = this.#context.boxAdapters.adapterFor(box, ChordEventBoxAdapter)
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
            this.#keyTrack.subscribe(() => this.dispatchChange())
        )
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#object.enabled.getValue()}
    get events(): EventCollection<ChordEventBoxAdapter> {return this.#events}
    get object(): ChordTrack {return this.#object}
    get keyTrack(): KeyTrackAdapter {return this.#keyTrack}

    eventAt(position: ppqn): Nullable<ChordEventBoxAdapter> {
        const event = this.#events.lowerEqual(position)
        return isDefined(event) && position < event.complete ? event : null
    }

    resolve(event: ChordEventBoxAdapter): Option<Harmony.Chord> {
        return event.resolve(this.#keyTrack.keyAt(event.position))
    }

    chordAt(position: ppqn): Option<Harmony.Chord> {
        if (!this.enabled) {return Option.None}
        const event = this.eventAt(position)
        return isDefined(event) ? this.resolve(event) : Option.None
    }

    /** @internal */
    dispatchChange(): void {this.#notifier.notify()}

    onSortingChanged(): void {
        this.#events.onIndexingChanged()
        this.dispatchChange()
    }

    terminate(): void {this.#terminator.terminate()}
}
