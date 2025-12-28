import {
    assert,
    int,
    Notifier,
    NumberComparator,
    Observer,
    SortedSet,
    Subscription,
    Terminable,
    UUID
} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {SignatureEventBoxAdapter} from "./SignatureEventBoxAdapter"
import {SignatureEventBox, TimelineBox} from "@opendaw/studio-boxes"

export type Signature = Readonly<{
    accumulatedPpqn: ppqn,
    accumulatedBars: int,
    nominator: int,
    denominator: int
}>

export class SignatureTrackAdapter implements Terminable {
    readonly #context: BoxAdaptersContext
    readonly #timelineBox: TimelineBox

    readonly changeNotifier: Notifier<void>
    readonly #adapters: SortedSet<UUID.Bytes, SignatureEventBoxAdapter>
    readonly #sortedByIndex: SortedSet<int, SignatureEventBoxAdapter>
    readonly #subscription: Subscription

    constructor(context: BoxAdaptersContext, timelineBox: TimelineBox) {
        this.#context = context
        this.#timelineBox = timelineBox

        this.changeNotifier = new Notifier<void>()
        this.#adapters = UUID.newSet<SignatureEventBoxAdapter>(adapter => adapter.uuid)
        this.#sortedByIndex = new SortedSet<int, SignatureEventBoxAdapter>(
            adapter => adapter.index,
            NumberComparator
        )

        this.#subscription = this.#timelineBox.signatureTrack.events.pointerHub.catchupAndSubscribe({
            onAdded: ({box}) => {
                if (box instanceof SignatureEventBox) {
                    const adapter = this.#context.boxAdapters.adapterFor(box, SignatureEventBoxAdapter)
                    const added = this.#adapters.add(adapter)
                    assert(added, "Could not add adapter")
                    this.#sortedByIndex.add(adapter)
                    this.dispatchChange()
                }
            },
            onRemoved: ({box: {address: {uuid}}}) => {
                const adapter = this.#adapters.removeByKey(uuid)
                this.#sortedByIndex.removeByKey(adapter.index)
                this.dispatchChange()
            }
        })
    }

    get storageSignature(): Readonly<[int, int]> {
        const {nominator, denominator} = this.#timelineBox.signature
        return [nominator.getValue(), denominator.getValue()]
    }

    subscribe(observer: Observer<void>): Subscription {return this.changeNotifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#timelineBox.signatureTrack.enabled.getValue()}
    get object(): TimelineBox["signatureTrack"] {return this.#timelineBox.signatureTrack}
    get count(): int {return this.#sortedByIndex.size()}

    dispatchChange(): void {this.changeNotifier.notify()}

    onSortingChanged(): void {
        // Re-sort by rebuilding - SortedSet doesn't have resort()
        const adapters = [...this.#sortedByIndex]
        this.#sortedByIndex.clear()
        adapters.forEach(adapter => this.#sortedByIndex.add(adapter))
        this.dispatchChange()
    }

    signatureAt(position: ppqn): Readonly<[int, int]> {
        let accumulatedPpqn: ppqn = 0
        let prevSignature: Readonly<[int, int]> = this.storageSignature
        let lastSignature: Readonly<[int, int]> = this.storageSignature

        for (const adapter of this.#sortedByIndex) {
            // Calculate this event's position using PREVIOUS signature
            accumulatedPpqn += PPQN.fromSignature(prevSignature[0], prevSignature[1]) * adapter.relativePosition
            if (accumulatedPpqn > position) {break}
            lastSignature = [adapter.nominator, adapter.denominator]
            prevSignature = lastSignature
        }
        return lastSignature
    }

    * iterateAll(): IterableIterator<Signature> {
        let accumulatedPpqn: ppqn = 0
        let accumulatedBars: int = 0
        let [nominator, denominator]: Readonly<[int, int]> = this.storageSignature
        for (const adapter of this.#sortedByIndex) {
            yield {
                accumulatedPpqn,
                accumulatedBars,
                nominator,
                denominator
            }
            accumulatedPpqn += PPQN.fromSignature(nominator, denominator) * adapter.relativePosition
            accumulatedBars += adapter.relativePosition
            nominator = adapter.nominator
            denominator = adapter.denominator
        }
    }

    adapterAt(index: int): SignatureEventBoxAdapter | undefined {
        return this.#sortedByIndex.get(index)
    }

    terminate(): void {this.#subscription.terminate()}
}
