import {EventCollection, ppqn, ValueEvent} from "@moises-ai/lib-dsp"
import {int, Nullable} from "@moises-ai/lib-std"
import {ValueModifyStrategy} from "@/ui/timeline/editors/value/ValueModifyStrategies.ts"
import {ValueEventBoxAdapter} from "@moises-ai/studio-adapters"
import {UIValueEvent} from "./UIValueEvent"

export interface ValueEventDraft extends UIValueEvent {
    get direction(): int
    get isSelected(): boolean
    set index(value: int)
}

export namespace ValueEventDraft {
    export const wrapUnselected = (event: ValueEvent): Readonly<ValueEventDraft> => {
        const value = event.value
        const position = event.position
        const index = event.index
        const interpolation = event.interpolation
        return ({type: "value-event", position, index, value, interpolation, direction: 0, isSelected: false})
    }

    export const wrapSelected = (event: UIValueEvent,
                                 strategy: ValueModifyStrategy): Readonly<ValueEventDraft> => {
        const value = strategy.readValue(event)
        const position = strategy.readPosition(event)
        const index = event.index
        const interpolation = event.interpolation
        const direction = Math.sign(position - event.position)
        return ({type: "value-event", position, index, value, interpolation, direction, isSelected: true})
    }

    export const min = (a: Nullable<ValueEventDraft>, b: Nullable<ValueEventDraft>): Nullable<ValueEventDraft> => {
        if (null === a) {return b}
        if (null === b) {return a}
        if (a.position > b.position) {return b}
        if (a.position < b.position) {return a}
        if (a.direction > b.direction) {return a}
        if (a.direction < b.direction) {return b}
        if (a.index > b.index) {return b}
        if (a.index < b.index) {return a}
        return b
    }

    export const max = (a: Nullable<ValueEventDraft>, b: Nullable<ValueEventDraft>): Nullable<ValueEventDraft> => {
        if (null === a) {return b}
        if (null === b) {return a}
        if (a.position < b.position) {return b}
        if (a.position > b.position) {return a}
        if (a.direction < b.direction) {return a}
        if (a.direction > b.direction) {return b}
        if (a.index < b.index) {return b}
        if (a.index > b.index) {return a}
        return b
    }

    export class Solver {
        readonly #strategy: ValueModifyStrategy

        readonly #selectedIterator: IterableIterator<ValueEventBoxAdapter>
        readonly #unselectedIterator: IterableIterator<ValueEventBoxAdapter>

        #nextUnselected: Nullable<ValueEventDraft> = null
        #nextSelected: Nullable<ValueEventDraft> = null
        #next: Nullable<ValueEventDraft> = null

        constructor(collection: EventCollection<ValueEventBoxAdapter>,
                    strategy: ValueModifyStrategy,
                    searchFrom: ppqn,
                    _searchMax: ppqn) {
            this.#strategy = strategy
            this.#selectedIterator = collection.iterateFrom(strategy.translateSearch(searchFrom), adapter => adapter.isSelected)
            this.#unselectedIterator = collection.iterateFrom(searchFrom)
            this.#nextSelected = this.#pullSelected()
            this.#nextUnselected = this.#pullUnselected()
            this.#evalNext()
        }

        * iterate(): IterableIterator<ValueEventDraft> {
            while (this.#next !== null) {
                const result: ValueEventDraft = this.#next
                this.#evalNext()
                yield result
            }
        }

        #evalNext(): void {
            this.#next = min(this.#nextUnselected, this.#nextSelected)
            if (this.#next === null) {return}
            while (this.#nextUnselected === min(this.#next, this.#nextUnselected)) {
                this.#nextUnselected = this.#pullUnselected()
            }
            while (this.#nextSelected === min(this.#nextSelected, this.#next)) {
                this.#nextSelected = this.#pullSelected()
            }
        }

        #pullSelected(): Nullable<ValueEventDraft> {
            const {done, value: event} = this.#selectedIterator.next()
            if (done) {return null}
            return wrapSelected(event, this.#strategy)
        }

        #pullUnselected(): Nullable<ValueEventDraft> {
            for (; ;) {
                const {done, value: event} = this.#unselectedIterator.next()
                if (done) {return null}
                if ((!event.isSelected || this.#strategy.showOrigin()) && this.#strategy.isVisible(event)) {
                    return wrapUnselected(event)
                }
            }
        }
    }
}