import {assert, int, Notifier, Observer, Option, panic, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {SignatureEventBoxAdapter} from "./SignatureEventBoxAdapter"
import {TimelineBox} from "@opendaw/studio-boxes"
import {IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {Pointers} from "@opendaw/studio-enums"

export type Signature = Readonly<{
    accumulatedPpqn: ppqn,
    accumulatedBars: int,
    nominator: int,
    denominator: int
}>

export class SignatureTrackAdapter implements Terminable {
    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #timelineBox: TimelineBox

    readonly changeNotifier: Notifier<void>
    readonly #adapters: IndexedBoxAdapterCollection<SignatureEventBoxAdapter, Pointers.SignatureAutomation>

    constructor(context: BoxAdaptersContext, timelineBox: TimelineBox) {
        this.#context = context
        this.#timelineBox = timelineBox

        this.changeNotifier = new Notifier<void>()
        this.#adapters = this.#terminator.own(IndexedBoxAdapterCollection.create(
            this.#timelineBox.signatureTrack.events,
            box => context.boxAdapters.adapterFor(box, SignatureEventBoxAdapter), Pointers.SignatureAutomation))

    }

    get storageSignature(): Readonly<[int, int]> {
        const {nominator, denominator} = this.#timelineBox.signature
        return [nominator.getValue(), denominator.getValue()]
    }

    subscribe(observer: Observer<void>): Subscription {return this.changeNotifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#timelineBox.signatureTrack.enabled.getValue()}
    get object(): TimelineBox["signatureTrack"] {return this.#timelineBox.signatureTrack}
    get size(): int {return this.#adapters.size()}

    dispatchChange(): void {this.changeNotifier.notify()}

    signatureAt(position: ppqn): Readonly<[int, int]> {
        assert(position >= 0.0, "Position in signatureAt must be non-negative")
        for (const {accumulatedPpqn, nominator, denominator} of this.iterateAll()) {
            if (accumulatedPpqn >= position) return [nominator, denominator]
        }
        return panic("Unvalid signature state")
    }

    * iterateAll(): IterableIterator<Signature> {
        let accumulatedPpqn: ppqn = 0
        let accumulatedBars: int = 0
        let [nominator, denominator]: Readonly<[int, int]> = this.storageSignature
        yield {accumulatedPpqn, accumulatedBars, nominator, denominator}
        for (const adapter of this.#adapters.adapters()) {
            accumulatedPpqn += PPQN.fromSignature(nominator, denominator) * adapter.relativePosition
            accumulatedBars += adapter.relativePosition
            nominator = adapter.nominator
            denominator = adapter.denominator
            yield {accumulatedPpqn, accumulatedBars, nominator, denominator}
        }
    }

    adapterAt(index: int): Option<SignatureEventBoxAdapter> {return this.#adapters.getAdapterByIndex(index)}

    terminate(): void {this.#terminator.terminate()}
}
