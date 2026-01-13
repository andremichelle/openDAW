import {
    int,
    isNull,
    Notifier,
    Nullable,
    Observer,
    Option,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {ppqn, PPQN} from "@moises-ai/lib-dsp"
import {SignatureEventBoxAdapter} from "./SignatureEventBoxAdapter"
import {Signature, SignatureEventBox, SignatureTrack, TimelineBox} from "@moises-ai/studio-boxes"
import {IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {Pointers} from "@moises-ai/studio-enums"

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
        this.#adapters = this.#terminator.own(
            IndexedBoxAdapterCollection.create(this.#signatureTrack.events,
                box => context.boxAdapters.adapterFor(box, SignatureEventBoxAdapter), Pointers.SignatureAutomation))
        this.#terminator.ownAll(
            this.#signature.subscribe(() => this.dispatchChange()),
            this.#signatureTrack.enabled.subscribe(() => this.dispatchChange()),
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

    nonEmpty(): boolean {return this.#adapters.size() > 0}

    dispatchChange(): void {this.changeNotifier.notify()}

    signatureAt(position: ppqn): Readonly<[int, int]> {
        position = Math.max(0, position)
        let result: Readonly<[int, int]> = this.storageSignature
        for (const {accumulatedPpqn, nominator, denominator} of this.iterateAll()) {
            if (accumulatedPpqn > position) {break}
            result = [nominator, denominator]
        }
        return result
    }

    * iterateAll(): IterableIterator<SignatureEvent> {
        let accumulatedPpqn: ppqn = 0
        let accumulatedBars: int = 0
        let [nominator, denominator]: Readonly<[int, int]> = this.storageSignature
        yield {index: -1, accumulatedPpqn, accumulatedBars, nominator, denominator}
        if (!this.#signatureTrack.enabled.getValue()) {return}
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

    createEvent(position: ppqn, nominator: int, denominator: int): void {
        const allEvents = Array.from(this.iterateAll())
        let prevEvent: SignatureEvent = allEvents[0]
        let insertAfterIndex = 0
        for (let i = 1; i < allEvents.length; i++) {
            if (allEvents[i].accumulatedPpqn > position) {break}
            prevEvent = allEvents[i]
            insertAfterIndex = i
        }
        const prevBarPpqn = PPQN.fromSignature(prevEvent.nominator, prevEvent.denominator)
        const barsFromPrev = (position - prevEvent.accumulatedPpqn) / prevBarPpqn
        const newRelativePosition = Math.max(1, Math.round(barsFromPrev))
        const newIndex = prevEvent.index + 1
        const successorEvents = allEvents.slice(insertAfterIndex + 1)
        const newEventPpqn = prevEvent.accumulatedPpqn + newRelativePosition * prevBarPpqn
        const newBarPpqn = PPQN.fromSignature(nominator, denominator)
        const adaptersToUpdate = successorEvents
            .map(event => ({event, adapter: this.adapterAt(event.index)}))
            .filter(({adapter}) => adapter.nonEmpty())
            .map(({event, adapter}) => ({event, adapter: adapter.unwrap()}))
        for (let i = 0; i < adaptersToUpdate.length; i++) {
            const {event, adapter} = adaptersToUpdate[i]
            adapter.box.index.setValue(event.index + 1)
            if (i === 0) {
                const barsToNext = (event.accumulatedPpqn - newEventPpqn) / newBarPpqn
                adapter.box.relativePosition.setValue(Math.max(1, Math.round(barsToNext)))
            }
        }
        SignatureEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.index.setValue(newIndex)
            box.relativePosition.setValue(newRelativePosition)
            box.nominator.setValue(nominator)
            box.denominator.setValue(denominator)
            box.events.refer(this.#signatureTrack.events)
        })
    }

    adapterAt(index: int): Option<SignatureEventBoxAdapter> {return this.#adapters.getAdapterByIndex(index)}

    moveEvent(adapter: SignatureEventBoxAdapter, targetPpqn: ppqn): void {
        const allEvents = Array.from(this.iterateAll()).slice(1)
        const movedIdx = allEvents.findIndex(e => e.index === adapter.index)
        if (movedIdx === -1) {return}
        const movedEvent = allEvents[movedIdx]
        if (targetPpqn === movedEvent.accumulatedPpqn) {return}
        const originalBars = allEvents.map(e => e.accumulatedBars)
        const targetBar = this.#ppqnToBar(targetPpqn, movedEvent.index)
        if (targetBar === movedEvent.accumulatedBars) {return}
        const newBars = [...originalBars]
        newBars[movedIdx] = targetBar
        const sortedIndices = newBars
            .map((bar, i) => ({bar, i}))
            .sort((a, b) => a.bar - b.bar)
            .map(x => x.i)
        const adapters = allEvents.map(e => this.adapterAt(e.index).unwrap())
        for (let newIdx = 0; newIdx < sortedIndices.length; newIdx++) {
            adapters[sortedIndices[newIdx]].box.index.setValue(newIdx)
        }
        let prevBar = 0
        for (let i = 0; i < sortedIndices.length; i++) {
            const origIdx = sortedIndices[i]
            const eventAdapter = adapters[origIdx]
            const bar = newBars[origIdx]
            const relPos = Math.max(1, bar - prevBar)
            eventAdapter.box.relativePosition.setValue(relPos)
            prevBar = bar
        }
    }

    #ppqnToBar(position: ppqn, excludeIndex: int): int {
        let prevEvent: Nullable<SignatureEvent> = null
        for (const event of this.iterateAll()) {
            if (event.index === excludeIndex) {continue}
            if (event.accumulatedPpqn > position) {break}
            prevEvent = event
        }
        if (isNull(prevEvent)) {
            const [nom, denom] = this.storageSignature
            const barPpqn = PPQN.fromSignature(nom, denom)
            return Math.max(1, Math.round(position / barPpqn))
        }
        const barPpqn = PPQN.fromSignature(prevEvent.nominator, prevEvent.denominator)
        const barsFromEvent = Math.round((position - prevEvent.accumulatedPpqn) / barPpqn)
        return Math.max(1, prevEvent.accumulatedBars + barsFromEvent)
    }

    #findSignatureEventAt(position: ppqn): { event: SignatureEvent, barPpqn: ppqn } {
        let prevEvent: Nullable<SignatureEvent> = null
        for (const event of this.iterateAll()) {
            if (event.accumulatedPpqn > position) {break}
            prevEvent = event
        }
        if (isNull(prevEvent)) {
            const [nominator, denominator] = this.storageSignature
            return {
                event: {index: -1, accumulatedPpqn: 0, accumulatedBars: 0, nominator, denominator},
                barPpqn: PPQN.fromSignature(nominator, denominator)
            }
        }
        return {
            event: prevEvent,
            barPpqn: PPQN.fromSignature(prevEvent.nominator, prevEvent.denominator)
        }
    }

    floorToBar(position: ppqn): ppqn {
        const {event, barPpqn} = this.#findSignatureEventAt(position)
        const barsFromEvent = Math.floor((position - event.accumulatedPpqn) / barPpqn)
        return event.accumulatedPpqn + barsFromEvent * barPpqn
    }

    ceilToBar(position: ppqn): ppqn {
        const {event, barPpqn} = this.#findSignatureEventAt(position)
        const barsFromEvent = Math.ceil((position - event.accumulatedPpqn) / barPpqn)
        return event.accumulatedPpqn + barsFromEvent * barPpqn
    }

    roundToBar(position: ppqn): ppqn {
        const {event, barPpqn} = this.#findSignatureEventAt(position)
        const barsFromEvent = Math.round((position - event.accumulatedPpqn) / barPpqn)
        return event.accumulatedPpqn + barsFromEvent * barPpqn
    }

    barLengthAt(position: ppqn): ppqn {
        const [nom, denom] = this.signatureAt(position)
        return PPQN.fromSignature(nom, denom)
    }

    getBarInterval(position: ppqn): { position: ppqn, complete: ppqn } {
        const {event, barPpqn} = this.#findSignatureEventAt(position)
        const barsFromEvent = Math.floor((position - event.accumulatedPpqn) / barPpqn)
        const start = event.accumulatedPpqn + barsFromEvent * barPpqn
        return {position: start, complete: start + barPpqn}
    }

    terminate(): void {this.#terminator.terminate()}
}
