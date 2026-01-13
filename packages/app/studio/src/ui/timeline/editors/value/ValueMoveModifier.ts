import {
    Arrays,
    asDefined,
    assert,
    clampUnit,
    int,
    isNull,
    Notifier,
    Nullable,
    NumberComparator,
    Observer,
    Option,
    Selection,
    Terminable,
    unitValue,
    ValueAxis,
    ValueMapping
} from "@moises-ai/lib-std"
import {Snapping} from "@/ui/timeline/Snapping.ts"
import {BoxEditing} from "@moises-ai/lib-box"
import {ValueEventBoxAdapter, ValueEventCollectionBoxAdapter} from "@moises-ai/studio-adapters"
import {EventCollection, Interpolation, ppqn, ValueEvent} from "@moises-ai/lib-dsp"
import {ValueModifier} from "./ValueModifier"
import {ValueEventDraft} from "./ValueEventDraft.ts"
import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {Dragging} from "@moises-ai/lib-dom"
import {UIValueEvent} from "@/ui/timeline/editors/value/UIValueEvent.ts"

import {ValueContext} from "@/ui/timeline/editors/value/ValueContext"

type Construct = Readonly<{
    element: Element
    context: ValueContext
    selection: Selection<ValueEventBoxAdapter>
    valueAxis: ValueAxis
    eventMapping: ValueMapping<number>
    snapping: Snapping
    pointerPulse: ppqn
    pointerValue: unitValue
    reference: ValueEventBoxAdapter
    collection: ValueEventCollectionBoxAdapter
}>

type SnapGuide = {
    value: number
    index: int
    position: number
}

export const SnapValueThresholdInPixels = 8

export class ValueMoveModifier implements ValueModifier {
    static create(construct: Construct): ValueMoveModifier {return new ValueMoveModifier(construct)}

    readonly #element: Element
    readonly #context: ValueContext
    readonly #selection: Selection<ValueEventBoxAdapter>
    readonly #valueAxis: ValueAxis
    readonly #eventMapping: ValueMapping<number>
    readonly #snapping: Snapping
    readonly #pointerPulse: ppqn
    readonly #pointerValue: unitValue
    readonly #reference: ValueEventBoxAdapter
    readonly #collection: ValueEventCollectionBoxAdapter

    readonly #notifier: Notifier<void>
    readonly #masks: ReadonlyArray<[ppqn, ppqn]>
    readonly #snapValues: ReadonlyArray<number>

    #copy: boolean
    #freezeMode: boolean
    #deltaValue: number
    #deltaPosition: ppqn
    #snapValue: Option<number>

    private constructor({
                            element, context, selection, valueAxis, eventMapping, snapping,
                            pointerPulse, pointerValue, reference, collection
                        }: Construct) {
        this.#element = element
        this.#context = context
        this.#selection = selection
        this.#valueAxis = valueAxis
        this.#eventMapping = eventMapping
        this.#snapping = snapping
        this.#pointerPulse = pointerPulse
        this.#pointerValue = pointerValue
        this.#reference = reference
        this.#collection = collection

        this.#notifier = new Notifier<void>()
        this.#masks = this.#buildMasks()
        this.#snapValues = this.#buildSnapValues()

        this.#copy = false
        this.#freezeMode = false
        this.#deltaValue = 0.0
        this.#deltaPosition = 0
        this.#snapValue = Option.None
    }

    subscribeUpdate(observer: Observer<void>): Terminable {return this.#notifier.subscribe(observer)}

    showOrigin(): boolean {return this.#copy}
    snapValue(): Option<number> {return this.#snapValue}
    translateSearch(value: ppqn): ppqn {return value - this.#deltaPosition}
    isVisible(event: ValueEvent): boolean {
        const deltaPosition = this.#deltaPosition
        const position = event.position - deltaPosition
        for (const [min, max] of this.#masks) {
            if ((min < position || (deltaPosition > 0 && min === position))
                && (position < max || (deltaPosition < 0 && max === position))) {
                return false
            }
        }
        return true
    }
    readPosition(adapter: ValueEvent): ppqn {return adapter.position + this.#deltaPosition}
    readValue(event: ValueEvent): number {
        return this.#context.quantize(this.#eventMapping.y(clampUnit(this.#eventMapping.x(event.value) + this.#deltaValue)))
    }
    readInterpolation(event: UIValueEvent): Interpolation {return event.interpolation}
    iterator(searchMin: ppqn, searchMax: ppqn): IterableIterator<ValueEventDraft> {
        return new ValueEventDraft.Solver(this.#eventCollection(), this,
            searchMin - Math.max(0, this.#deltaPosition), searchMax).iterate()
    }
    readContentDuration(owner: ValueEventOwnerReader): number {return owner.contentDuration}
    update(event: Dragging.Event): void {
        const {clientX, clientY, altKey: freezeMode, ctrlKey, shiftKey} = event
        const clientRect = this.#element.getBoundingClientRect()
        const localX = clientX - clientRect.left
        const localY = clientY - clientRect.top
        const pointerValue = this.#context.quantize(this.#valueAxis.axisToValue(localY))
        const closest: Nullable<SnapGuide> = shiftKey ? null : this.#snapValues
            .map<SnapGuide>((value: number, index: int) =>
                ({value, index, position: this.#valueAxis.valueToAxis(value)}))
            .reduce((closest: Nullable<SnapGuide>, guide: SnapGuide) =>
                Math.abs(guide.position - localY) <= (
                    closest === null
                        ? SnapValueThresholdInPixels
                        : Math.abs(closest.position - localY))
                    ? guide : closest, null)
        const snapValue = closest === null ? Option.None : Option.wrap(closest.value)
        const deltaValue: number = !freezeMode ? snapValue.match({
            none: () => {
                const unitValue = this.#eventMapping.x(pointerValue)
                return unitValue <= 0.0 || unitValue >= 1.0
                    ? unitValue - this.#eventMapping.x(this.#reference.value)
                    : unitValue - this.#eventMapping.x(this.#pointerValue)
            },
            some: value => this.#eventMapping.x(value) - this.#eventMapping.x(this.#reference.value)
        }) : 0.0
        const deltaPosition: int = this.#snapping.computeDelta(this.#pointerPulse, localX, this.#reference.position)
        let change = false
        if (this.#deltaPosition !== deltaPosition) {
            this.#deltaPosition = deltaPosition
            change = true
        }
        if (this.#deltaValue !== deltaValue) {
            this.#deltaValue = deltaValue
            change = true
        }
        if (this.#copy !== ctrlKey) {
            this.#copy = ctrlKey
            change = true
        }
        if (this.#snapValue !== snapValue) {
            this.#snapValue = snapValue
            change = true
        }
        if (this.#freezeMode !== freezeMode) {
            this.#freezeMode = freezeMode
            change = true
        }
        if (change) {this.#dispatchChange()}
    }

    approve(editing: BoxEditing): void {
        if (this.#deltaValue === 0 && this.#deltaPosition === 0) {
            if (this.#copy) {this.#dispatchChange()} // reset visuals
            return
        }
        // take 'em all
        const collection = this.#eventCollection()
        const solver = new ValueEventDraft.Solver(collection, this, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        const stream: Array<ValueEventDraft> = []
        for (const event of solver.iterate()) {stream.push(event) }
        // iterator
        const pull = (() => {
            const iterator = collection.asArray().slice().values()
            return (): Nullable<ValueEventBoxAdapter> => {
                const {done, value} = iterator.next()
                return done ? null : value
            }
        })()
        // update events
        const iterable = stream.values()
        const {done, value} = iterable.next()
        assert(!done, "Internal Error")
        const obsolete: Array<ValueEventDraft> = []
        let index: int = 0
        let prev: ValueEventDraft = asDefined(value)
        for (const next of iterable) {
            if (prev.position === next.position) {
                if (index === 0) {prev.index = 0}
                if (++index > 1) {obsolete.push(prev)}
                next.index = 1
            } else {
                index = 0
                next.index = 0
            }
            prev = next
        }
        obsolete.forEach(event => Arrays.remove(stream, event))

        editing.modify(() => {
            // Collect all (stock, target) pairs
            const pairs: Array<{ stock: Nullable<ValueEventBoxAdapter>, target: ValueEventDraft }> = []
            stream.forEach(target => pairs.push({stock: pull(), target}))
            // Collect obsolete events (those not paired with any target)
            // These must be deleted FIRST to avoid collisions with events being moved
            const obsoleteEvents: Array<ValueEventBoxAdapter> = []
            while (true) {
                const event = pull()
                if (event === null) {break}
                obsoleteEvents.push(event)
            }
            // Remove ALL events from the collection first to prevent duplicates during sorts
            obsoleteEvents.forEach(event => collection.remove(event))
            pairs.forEach(({stock}) => { if (stock !== null) collection.remove(stock) })
            const adapters: Array<ValueEventBoxAdapter> = []
            for (const {stock, target} of pairs) {
                const adapter = isNull(stock)
                    ? this.#collection.createEvent(target)
                    : stock.copyFrom(target)
                adapters.push(adapter)
                if (target.isSelected && !adapter.isSelected) {
                    this.#selection.select(adapter)
                } else if (!target.isSelected && adapter.isSelected) {
                    this.#selection.deselect(adapter)
                }
            }
            // Add all back, then delete obsolete boxes
            adapters.forEach(adapter => collection.add(adapter))
            obsoleteEvents.forEach(event => event.box.delete())
        })
        this.#dispatchChange()
    }

    cancel(): void {
        this.#copy = false
        this.#snapValue = Option.None
        this.#freezeMode = false
        this.#deltaValue = 0
        this.#deltaPosition = 0
        this.#dispatchChange()
    }

    #dispatchChange(): void {this.#notifier.notify()}

    #buildMasks(): ReadonlyArray<[ppqn, ppqn]> {
        const masks: Array<[ppqn, ppqn]> = []
        let min: int = Number.MIN_SAFE_INTEGER
        let max: int = Number.MAX_SAFE_INTEGER
        let started: boolean = false
        let ended: boolean = false
        for (const adapter of this.#eventCollection().asArray()) {
            if (adapter.isSelected) {
                if (started) {
                    max = adapter.position
                    ended = max > min
                } else {
                    min = adapter.position
                    started = true
                }
            } else if (ended) {
                masks.push([min, max])
                min = Number.MIN_SAFE_INTEGER
                max = Number.MAX_SAFE_INTEGER
                started = false
                ended = false
            } else {
                started = false
                ended = false
            }
        }
        if (ended) {masks.push([min, max])}
        return masks
    }

    #buildSnapValues(): ReadonlyArray<number> {
        const result = new Set<number>([this.#context.currentValue])
        this.#eventCollection().asArray().forEach(event => result.add(event.value))
        return Array.from(result).sort(NumberComparator)
    }

    #eventCollection(): EventCollection<ValueEventBoxAdapter> {return this.#collection.events}
}