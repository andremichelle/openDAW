import {EventCollection, Interpolation, LoopableRegion, ppqn, PPQN, RegionCollection} from "@opendaw/lib-dsp"
import {
    Arrays,
    int,
    Integer,
    isDefined,
    Maybe,
    Notifier,
    Observer,
    Option,
    safeExecute,
    Subscription,
    Terminable,
    Terminator,
    unitValue,
    UUID
} from "@opendaw/lib-std"
import {Address, Field, Propagation, Update} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {TrackBoxAdapter} from "../TrackBoxAdapter"
import {LoopableRegionBoxAdapter, RegionBoxAdapter, RegionBoxAdapterVisitor} from "../RegionBoxAdapter"
import {ValueEventCollectionBoxAdapter} from "../collection/ValueEventCollectionBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ValueEventBox, ValueEventCollectionBox, ValueRegionBox} from "@opendaw/studio-boxes"
import {InterpolationFieldAdapter} from "../event/InterpolationFieldAdapter"
import {ValueEventBoxAdapter} from "../event/ValueEventBoxAdapter"
import {MutableRegion} from "./MutableRegion"

type CopyToParams = {
    target?: Field<Pointers.RegionCollection>
    position?: ppqn
    duration?: ppqn
    loopOffset?: ppqn
    loopDuration?: ppqn
    consolidate?: boolean
}

export class ValueRegionBoxAdapter
    implements LoopableRegionBoxAdapter<ValueEventCollectionBoxAdapter>, MutableRegion {
    readonly type = "value-region"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: ValueRegionBox

    readonly #changeNotifier: Notifier<void>

    #isSelected: boolean
    #isConstructing: boolean // Prevents stack overflow due to infinite adapter queries
    #eventCollectionSubscription: Subscription = Terminable.Empty

    constructor(context: BoxAdaptersContext, box: ValueRegionBox) {
        this.#context = context
        this.#box = box

        this.#isConstructing = true
        this.#changeNotifier = new Notifier<void>()
        this.#isSelected = false

        this.#terminator.own(this.#box.pointerHub.subscribe({
            onAdded: () => this.#dispatchChange(),
            onRemoved: () => this.#dispatchChange()
        }))

        this.#terminator.own(this.#box.subscribe(Propagation.Children, (update: Update) => {
            if (this.trackBoxAdapter.isEmpty()) {return}
            if (update.type === "primitive" || update.type === "pointer") {
                const track = this.trackBoxAdapter.unwrap()
                if (this.#box.position.address.equals(update.address)) {
                    track.regions.onIndexingChanged()
                    this.#dispatchChange()
                } else {
                    this.#dispatchChange()
                }
            }
        }))
        this.#terminator.own(this.#box.events.catchupAndSubscribe(({targetVertex}) => {
            this.#eventCollectionSubscription.terminate()
            this.#eventCollectionSubscription = targetVertex.match({
                none: () => Terminable.Empty,
                some: ({box}) => this.#context.boxAdapters
                    .adapterFor(box, ValueEventCollectionBoxAdapter)
                    .subscribeChange(() => this.#dispatchChange())
            })
            this.#dispatchChange()
        }))

        this.#isConstructing = false
    }

    valueAt(position: ppqn, fallback: unitValue): unitValue {
        const content = this.optCollection
        return content.isEmpty() ? fallback : content.unwrap().valueAt(LoopableRegion.globalToLocal(this, position), fallback)
    }

    incomingValue(fallback: unitValue): unitValue {
        const content = this.optCollection
        if (content.isEmpty()) {return fallback}
        const zeroEvent = content.unwrap().events.greaterEqual(0)
        if (isDefined(zeroEvent) && zeroEvent.position === 0) {return zeroEvent.value}
        return this.valueAt(this.position, fallback)
    }

    outgoingValue(fallback: unitValue): unitValue {
        const optContent = this.optCollection
        if (optContent.isEmpty()) {return fallback}
        const content: ValueEventCollectionBoxAdapter = optContent.unwrap()
        const endsOnLoopPass = (this.complete - this.offset) % this.loopDuration === 0
        return endsOnLoopPass
            ? content.valueAt(this.loopDuration, fallback)
            : content.valueAt(LoopableRegion.globalToLocal(this, this.complete), fallback)
    }

    subscribeChange(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}

    accept<R>(visitor: RegionBoxAdapterVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitValueRegionBoxAdapter, this)
    }

    onSelected(): void {
        this.#isSelected = true
        this.#dispatchChange()
    }

    onDeselected(): void {
        this.#isSelected = false
        this.#dispatchChange()
    }

    get isSelected(): boolean {return this.#isSelected}

    onValuesPropertyChanged(): void {this.#dispatchChange()}
    onValuesSortingChanged(): void {this.onValuesPropertyChanged()}

    terminate(): void {
        this.#eventCollectionSubscription.terminate()
        this.#terminator.terminate()
    }

    get box(): ValueRegionBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get position(): ppqn {return this.#box.position.getValue()}
    get duration(): ppqn {return this.#box.duration.getValue()}
    get loopOffset(): ppqn {return this.#box.loopOffset.getValue()}
    get loopDuration(): ppqn {return this.#box.loopDuration.getValue()}
    get offset(): ppqn {return this.position - this.loopOffset}
    get complete(): ppqn {return this.position + this.duration}

    resolveDuration(_position: ppqn): ppqn {return this.duration}
    resolveComplete(position: ppqn): ppqn {return position + this.duration}
    resolveLoopDuration(_position: ppqn): ppqn {return this.loopDuration}
    get mute(): boolean {return this.#box.mute.getValue()}
    get hue(): int {return this.#box.hue.getValue()}
    get hasCollection() {return !this.optCollection.isEmpty()}
    get events(): Option<EventCollection<ValueEventBoxAdapter>> {
        return this.optCollection.map(collection => collection.events)
    }
    get optCollection(): Option<ValueEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, ValueEventCollectionBoxAdapter))
    }
    get label(): string {return this.#box.label.getValue()}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {
        if (this.#isConstructing) {return Option.None}
        return this.#box.regions.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TrackBoxAdapter))
    }
    get isMirrowed(): boolean {return this.optCollection.mapOr(adapter => adapter.numOwners > 1, false)}
    get canMirror(): boolean {return true}
    get canResize(): boolean {return true}

    set position(value: ppqn) {this.#box.position.setValue(value)}
    set duration(value: ppqn) {this.#box.duration.setValue(value)}
    set loopOffset(value: ppqn) {this.#box.loopOffset.setValue(value)}
    set loopDuration(value: ppqn) {this.#box.loopDuration.setValue(value)}

    moveContentStart(delta: ppqn): void {
        this.optCollection.ifSome(collection => collection.events.asArray()
            .forEach(event => event.box.position.setValue(event.position - delta)))
        this.position = this.position + delta
        this.loopDuration = this.loopDuration - delta
        this.duration = this.duration - delta
    }

    copyTo(params?: CopyToParams): ValueRegionBoxAdapter {
        const eventCollection = this.optCollection.unwrap("Cannot make copy without event-collection")
        const eventTarget = params?.consolidate === true
            ? eventCollection.copy().box.owners
            : eventCollection.box.owners
        return this.#context.boxAdapters.adapterFor(ValueRegionBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(params?.position ?? this.position)
            box.duration.setValue(params?.duration ?? this.duration)
            box.loopOffset.setValue(params?.loopOffset ?? this.loopOffset)
            box.loopDuration.setValue(params?.loopDuration ?? this.loopDuration)
            box.hue.setValue(this.hue)
            box.label.setValue(this.label)
            box.mute.setValue(this.mute)
            box.events.refer(eventTarget)
            box.regions.refer(params?.target ?? this.#box.regions.targetVertex.unwrap())
        }), ValueRegionBoxAdapter)
    }

    consolidate(): void {
        if (!this.isMirrowed) {return}
        this.events.ifSome(events => {
            const graph = this.#context.boxGraph
            const collectionBox = ValueEventCollectionBox.create(graph, UUID.generate())
            events.asArray().forEach(adapter => adapter.copyTo({events: collectionBox.events}))
            this.#box.events.refer(collectionBox.owners)
        })
    }

    canFlatten(regions: ReadonlyArray<RegionBoxAdapter<unknown>>): boolean {
        return regions.length > 0
            && Arrays.satisfy(regions, (a, b) => a.trackBoxAdapter.contains(b.trackBoxAdapter.unwrap()))
            && regions.every(region => region.isSelected && region instanceof ValueRegionBoxAdapter)
    }

    flatten(regions: ReadonlyArray<RegionBoxAdapter<unknown>>): Option<ValueRegionBox> {
        if (!this.canFlatten(regions)) {return Option.None}
        const graph = this.#context.boxGraph
        const sorted = regions.toSorted(RegionCollection.Comparator)
        const first = Arrays.getFirst(sorted, "Internal error (no first)")
        const last = Arrays.getLast(sorted, "Internal error (no last)")
        const rangeMin = first.position
        const rangeMax = last.position + last.duration
        const trackBoxAdapter = first.trackBoxAdapter.unwrap()
        const overlapping = Array.from(trackBoxAdapter.regions.collection.iterateRange(rangeMin, rangeMax))
        type Entry = { position: ppqn, value: unitValue, interpolation: Interpolation }
        const entries: Array<Entry> = []
        overlapping
            .filter(region => region.isSelected)
            .forEach(anyRegion => {
                const region = anyRegion as ValueRegionBoxAdapter
                const collection = region.optCollection.unwrap()
                const events = collection.events
                for (const {rawStart, regionStart, regionEnd} of LoopableRegion.locateLoops(region, region.position, region.complete)) {
                    const searchMin = regionStart - rawStart
                    const searchMax = regionEnd - rawStart
                    const firstContent = events.greaterEqual(searchMin)
                    if (!isDefined(firstContent) || firstContent.position !== searchMin) {
                        const lowerEvent = events.lowerEqual(searchMin)
                        if (isDefined(lowerEvent)) {
                            entries.push({
                                position: regionStart - rangeMin,
                                value: collection.valueAt(searchMin, 0),
                                interpolation: lowerEvent.interpolation
                            })
                        }
                    }
                    let addedBoundary = false
                    for (const event of events.iterateRange(searchMin, Integer.MAX_VALUE)) {
                        const globalPos = event.position + rawStart
                        if (globalPos < regionEnd) {
                            entries.push({
                                position: globalPos - rangeMin,
                                value: event.value,
                                interpolation: event.interpolation
                            })
                        } else if (globalPos === regionEnd) {
                            entries.push({
                                position: globalPos - rangeMin,
                                value: event.value,
                                interpolation: Interpolation.None
                            })
                            addedBoundary = true
                            break
                        } else {
                            entries.push({
                                position: regionEnd - rangeMin,
                                value: collection.valueAt(searchMax, 0),
                                interpolation: Interpolation.None
                            })
                            addedBoundary = true
                            break
                        }
                    }
                    if (!addedBoundary) {
                        entries.push({
                            position: regionEnd - rangeMin,
                            value: collection.valueAt(searchMax, 0),
                            interpolation: Interpolation.None
                        })
                    }
                }
            })
        const cleaned: Array<Entry> = []
        for (const entry of entries) {
            const prev = cleaned.length > 0 ? cleaned[cleaned.length - 1] : undefined
            if (isDefined(prev) && prev.position === entry.position && prev.value === entry.value) {
                cleaned[cleaned.length - 1] = entry
            } else {
                cleaned.push(entry)
            }
        }
        const collectionBox = ValueEventCollectionBox.create(graph, UUID.generate())
        let idx = 0
        while (idx < cleaned.length) {
            let end = idx + 1
            while (end < cleaned.length && cleaned[end].position === cleaned[idx].position) {end++}
            const firstEntry = cleaned[idx]
            const lastEntry = cleaned[end - 1]
            const eventBox = ValueEventBox.create(graph, UUID.generate(), box => {
                box.position.setValue(firstEntry.position)
                box.index.setValue(0)
                box.value.setValue(firstEntry.value)
                box.events.refer(collectionBox.events)
            })
            InterpolationFieldAdapter.write(eventBox.interpolation, end - idx > 1 ? Interpolation.None : firstEntry.interpolation)
            if (end - idx > 1) {
                const lastBox = ValueEventBox.create(graph, UUID.generate(), box => {
                    box.position.setValue(lastEntry.position)
                    box.index.setValue(1)
                    box.value.setValue(lastEntry.value)
                    box.events.refer(collectionBox.events)
                })
                InterpolationFieldAdapter.write(lastBox.interpolation, lastEntry.interpolation)
            }
            idx = end
        }
        overlapping.forEach(({box}) => box.delete())
        return Option.wrap(ValueRegionBox.create(graph, UUID.generate(), box => {
            box.position.setValue(rangeMin)
            box.duration.setValue(rangeMax - rangeMin)
            box.loopDuration.setValue(rangeMax - rangeMin)
            box.loopOffset.setValue(0)
            box.hue.setValue(this.hue)
            box.mute.setValue(this.mute)
            box.label.setValue(this.label)
            box.events.refer(collectionBox.owners)
            box.regions.refer(trackBoxAdapter.box.regions)
        }))
    }

    toString(): string {return `{ValueRegionBoxAdapter ${UUID.toString(this.#box.address.uuid)} p: ${PPQN.toString(this.position)}, c: ${PPQN.toString(this.complete)}}`}

    #dispatchChange(): void {
        this.#changeNotifier.notify()
        this.trackBoxAdapter.unwrapOrNull()?.regions?.dispatchChange()
    }
}