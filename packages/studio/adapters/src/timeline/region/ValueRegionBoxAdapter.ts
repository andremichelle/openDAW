import {EventCollection, LoopableRegion, ppqn, PPQN, RegionCollection} from "@moises-ai/lib-dsp"
import {
    Arrays,
    int,
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
} from "@moises-ai/lib-std"
import {Address, Field, Propagation, Update} from "@moises-ai/lib-box"
import {Pointers} from "@moises-ai/studio-enums"
import {TrackBoxAdapter} from "../TrackBoxAdapter"
import {LoopableRegionBoxAdapter, RegionBoxAdapter, RegionBoxAdapterVisitor} from "../RegionBoxAdapter"
import {ValueEventCollectionBoxAdapter} from "../collection/ValueEventCollectionBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ValueEventCollectionBox, ValueRegionBox} from "@moises-ai/studio-boxes"
import {ValueEventBoxAdapter} from "../event/ValueEventBoxAdapter"
import {MutableRegion} from "./MutableRegion"

type CopyToParams = {
    track?: Field<Pointers.RegionCollection>
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

    incomingValue(fallback: unitValue): unitValue {return this.valueAt(this.position, fallback)}

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
    resolveLoopOffset(_position: ppqn): ppqn {return this.loopOffset}
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
            box.regions.refer(params?.track ?? this.#box.regions.targetVertex.unwrap())
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

    canFlatten(_regions: ReadonlyArray<RegionBoxAdapter<unknown>>): boolean {
        return false
        /*return regions.length > 0 && Arrays.satisfy(regions, (a, b) => a.trackAdapter.contains(b.trackAdapter.unwrap()))
                && regions.every(region => region.isSelected && region instanceof ValueRegionBoxAdapter)*/
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
        const collectionBox = ValueEventCollectionBox.create(graph, UUID.generate())
        const overlapping = Array.from(trackBoxAdapter.regions.collection.iterateRange(rangeMin, rangeMax))
        overlapping
            .filter(region => region.isSelected)
            .forEach(anyRegion => {
                    const region = anyRegion as ValueRegionBoxAdapter // we made that sure in canFlatten
                    for (const {
                        resultStart,
                        resultEnd,
                        rawStart
                    } of LoopableRegion.locateLoops(region, region.position, region.complete)) {
                        const searchStart = Math.floor(resultStart - rawStart)
                        const searchEnd = Math.floor(resultEnd - rawStart)
                        for (const _event of region.events.unwrap().iterateRange(searchStart, searchEnd)) {
                            // TODO Flatten
                        }
                    }
                }
            )
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