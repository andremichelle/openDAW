import {assert, int, Notifier, Observer, Option, panic, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {SignatureEventBoxAdapter} from "./SignatureEventBoxAdapter"
import {Signature, SignatureTrack, TimelineBox} from "@opendaw/studio-boxes"
import {IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {Pointers} from "@opendaw/studio-enums"

export type SignatureEvent = Readonly<{
    index: int,
    accumulatedPpqn: ppqn,
    accumulatedBars: int,
    nominator: int,
    denominator: int
}>

export class SignatureTrackAdapter implements Terminable {
    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #signature: Signature
    readonly #signatureTrack: SignatureTrack

    readonly changeNotifier: Notifier<void>
    readonly #adapters: IndexedBoxAdapterCollection<SignatureEventBoxAdapter, Pointers.SignatureAutomation>

    constructor(context: BoxAdaptersContext, signature: Signature, signatureTrack: SignatureTrack) {
        this.#context = context
        this.#signature = signature
        this.#signatureTrack = signatureTrack

        this.changeNotifier = new Notifier<void>()
        this.#adapters = this.#terminator.own(IndexedBoxAdapterCollection.create(
            this.#signatureTrack.events,
            box => context.boxAdapters.adapterFor(box, SignatureEventBoxAdapter), Pointers.SignatureAutomation))
        this.#terminator.ownAll(
            this.#signature.subscribe(() => this.dispatchChange()),
            this.#adapters.subscribe({
                onAdd: (_adapter: SignatureEventBoxAdapter) => this.changeNotifier.notify(),
                onRemove: (_adapter: SignatureEventBoxAdapter) => this.changeNotifier.notify(),
                onReorder: (_adapter: SignatureEventBoxAdapter) => this.changeNotifier.notify()
            })
        )
    }

    subscribe(observer: Observer<void>): Subscription {return this.changeNotifier.subscribe(observer)}

    get context(): BoxAdaptersContext {return this.#context}
    get enabled(): boolean {return this.#signatureTrack.enabled.getValue()}
    get object(): TimelineBox["signatureTrack"] {return this.#signatureTrack}
    get size(): int {return this.#adapters.size()}
    get storageSignature(): Readonly<[int, int]> {
        const {nominator, denominator} = this.#signature
        return [nominator.getValue(), denominator.getValue()]
    }

    dispatchChange(): void {this.changeNotifier.notify()}

    signatureAt(position: ppqn): Readonly<[int, int]> {
        assert(position >= 0.0, "Position in signatureAt must be non-negative")
        for (const {accumulatedPpqn, nominator, denominator} of this.iterateAll()) {
            if (accumulatedPpqn >= position) return [nominator, denominator]
        }
        return panic("Unvalid signature state")
    }

    * iterateAll(): IterableIterator<SignatureEvent> {
        let accumulatedPpqn: ppqn = 0
        let accumulatedBars: int = 0
        let [nominator, denominator]: Readonly<[int, int]> = this.storageSignature
        yield {index: -1, accumulatedPpqn, accumulatedBars, nominator, denominator}
        for (const adapter of this.#adapters.adapters()) {
            accumulatedPpqn += PPQN.fromSignature(nominator, denominator) * adapter.relativePosition
            accumulatedBars += adapter.relativePosition
            nominator = adapter.nominator
            denominator = adapter.denominator
            yield {index: adapter.index, accumulatedPpqn, accumulatedBars, nominator, denominator}
        }
    }

    changeSignature(nominator: int, denominator: int): void {
        const originalEvents = Array.from(this.iterateAll()).slice(1)
        const originalPositions = originalEvents.map(e => e.accumulatedPpqn)
        this.#signature.nominator.setValue(nominator)
        this.#signature.denominator.setValue(denominator)
        // Recalculate each event's relativePosition to preserve approximate absolute positions.
        // This matches Logic Pro's behavior of preserving absolute time positions.
        let accumulatedPpqn: ppqn = 0.0
        let accumulatedFraction = 0.0
        let durationBar = PPQN.fromSignature(nominator, denominator)
        for (let i = 0; i < originalEvents.length; i++) {
            const event = originalEvents[i]
            const adapter = this.adapterAt(event.index)
            if (adapter.isEmpty()) {continue}
            const targetPpqn = originalPositions[i]
            const barsFrac = (targetPpqn - accumulatedPpqn) / durationBar
            const barsInt = Math.floor(barsFrac)
            const fraction = barsFrac - barsInt
            accumulatedFraction += fraction
            let relativePosition = barsInt
            if (accumulatedFraction >= 1.0) {
                relativePosition++
                accumulatedFraction--
            }
            relativePosition = Math.max(1, relativePosition)
            adapter.unwrap().box.relativePosition.setValue(relativePosition)
            accumulatedPpqn += relativePosition * durationBar
            durationBar = PPQN.fromSignature(event.nominator, event.denominator)
        }
    }

    deleteAdapter(adapter: SignatureEventBoxAdapter): void {
        const deleteIndex = adapter.index
        const allEvents = Array.from(this.iterateAll()).slice(1)
        const deleteEventIndex = allEvents.findIndex(e => e.index === deleteIndex)
        if (deleteEventIndex === -1) {return}

        // Capture original ppqn positions of events AFTER the deleted one
        const eventsAfter = allEvents.slice(deleteEventIndex + 1)
        const originalPositions = eventsAfter.map(e => e.accumulatedPpqn)

        // Determine the signature that will precede the remaining events
        const prevEvent = deleteEventIndex > 0 ? allEvents[deleteEventIndex - 1] : null
        const [prevNom, prevDenom] = prevEvent !== null
            ? [prevEvent.nominator, prevEvent.denominator]
            : this.storageSignature
        const prevAccumulatedPpqn = prevEvent !== null ? prevEvent.accumulatedPpqn : 0.0

        // Delete the adapter's box from the graph
        adapter.box.delete()

        // Recalculate relativePositions for events after the deleted one using round()
        let accumulatedPpqn: ppqn = prevAccumulatedPpqn
        let durationBar = PPQN.fromSignature(prevNom, prevDenom)

        for (let i = 0; i < eventsAfter.length; i++) {
            const event = eventsAfter[i]
            const eventAdapter = this.adapterAt(event.index)
            if (eventAdapter.isEmpty()) {continue}
            const targetPpqn = originalPositions[i]
            const exactBars = (targetPpqn - accumulatedPpqn) / durationBar
            const relativePosition = Math.max(1, Math.round(exactBars))
            eventAdapter.unwrap().box.relativePosition.setValue(relativePosition)
            accumulatedPpqn += relativePosition * durationBar
            durationBar = PPQN.fromSignature(event.nominator, event.denominator)
        }
    }

    adapterAt(index: int): Option<SignatureEventBoxAdapter> {return this.#adapters.getAdapterByIndex(index)}

    terminate(): void {this.#terminator.terminate()}
}
