import {assert, int, Notifier, Observer, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {EventCollection, ppqn} from "@opendaw/lib-dsp"
import {SignatureEventBoxAdapter} from "./SignatureEventBoxAdapter"
import {SignatureEventBox, SignatureTrack} from "@opendaw/studio-boxes"

export type Signature = Readonly<{ position: ppqn, nominator: int, denominator: int }>

export class SignatureTrackAdapter implements Terminable {
    readonly #context: BoxAdaptersContext
    readonly #object: SignatureTrack

    readonly changeNotifier: Notifier<void>
    readonly #adapters: SortedSet<UUID.Bytes, SignatureEventBoxAdapter>
    readonly #events: EventCollection<SignatureEventBoxAdapter>
    readonly #subscription: Subscription

    constructor(context: BoxAdaptersContext, object: SignatureTrack) {
        this.#context = context
        this.#object = object

        this.changeNotifier = new Notifier<void>()
        this.#adapters = UUID.newSet<SignatureEventBoxAdapter>(adapter => adapter.uuid)
        this.#events = EventCollection.create(SignatureEventBoxAdapter.Comparator)

        this.#subscription = this.#object.events.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                if (box instanceof SignatureEventBox) {
                    const adapter = this.#context.boxAdapters.adapterFor(box, SignatureEventBoxAdapter)
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
    get events(): EventCollection<SignatureEventBoxAdapter> {return this.#events}
    get object(): SignatureTrack {return this.#object}

    dispatchChange(): void {this.changeNotifier.notify()}

    onSortingChanged(): void {
        this.#events.onIndexingChanged()
        this.dispatchChange()
    }

    signatureAt(position: ppqn, fallback: Readonly<[int, int]>): Readonly<[int, int]> {
        const event = this.#events.lowerEqual(position)
        return event === null ? fallback : [event.nominator, event.denominator]
    }

    *iterateSignatures(from: ppqn, to: ppqn, fallback: Readonly<[int, int]>): IterableIterator<Signature> {
        const first = this.#events.lowerEqual(from)
        if (first === null || first.position < from) {
            const [nominator, denominator] = first === null ? fallback : [first.nominator, first.denominator]
            yield {position: from, nominator, denominator}
        }
        for (const event of this.#events.iterateFrom(from)) {
            if (event.position > to) {break}
            yield {position: event.position, nominator: event.nominator, denominator: event.denominator}
        }
    }

    terminate(): void {this.#subscription.terminate()}
}
