import {LoopableRegion, NoteEvent, ppqn, PPQN, RegionCollection} from "@opendaw/lib-dsp"
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
    UUID
} from "@opendaw/lib-std"
import {Address, Field, Propagation, Update} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {NoteEventCollectionBox, NoteRegionBox} from "@opendaw/studio-boxes"
import {TrackBoxAdapter} from "../TrackBoxAdapter"
import {LoopableRegionBoxAdapter, RegionBoxAdapter, RegionBoxAdapterVisitor} from "../RegionBoxAdapter"
import {NoteEventCollectionBoxAdapter} from "../collection/NoteEventCollectionBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {MutableRegion} from "./MutableRegion"

type CopyToParams = {
    target?: Field<Pointers.RegionCollection>
    position?: ppqn
    duration?: ppqn
    loopOffset?: ppqn
    loopDuration?: ppqn
    consolidate?: boolean
}

export class NoteRegionBoxAdapter
    implements LoopableRegionBoxAdapter<NoteEventCollectionBoxAdapter>, MutableRegion {
    readonly type = "note-region"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: NoteRegionBox

    readonly #changeNotifier: Notifier<void>
    readonly #isConstructing: boolean // Prevents stack overflow due to infinite adapter queries

    #isSelected: boolean
    #eventCollectionSubscription: Subscription = Terminable.Empty

    constructor(context: BoxAdaptersContext, box: NoteRegionBox) {
        this.#context = context
        this.#box = box

        this.#changeNotifier = new Notifier<void>()
        this.#isSelected = false
        this.#isConstructing = true
        this.#terminator.ownAll(
            this.#box.pointerHub.subscribe({
                onAdded: () => this.#dispatchChange(),
                onRemoved: () => this.#dispatchChange()
            }),
            this.#box.subscribe(Propagation.Children, (update: Update) => {
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
            }),
            this.#box.events.catchupAndSubscribe(({targetVertex}) => {
                this.#eventCollectionSubscription.terminate()
                this.#eventCollectionSubscription = targetVertex.match({
                    none: () => Terminable.Empty,
                    some: ({box}) => this.#context.boxAdapters
                        .adapterFor(box, NoteEventCollectionBoxAdapter)
                        .subscribeChange(() => this.#dispatchChange())
                })
                this.#dispatchChange()
            })
        )
        this.#isConstructing = false
    }

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

    subscribeChange(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}
    accept<R>(visitor: RegionBoxAdapterVisitor<R>): Maybe<R> {return safeExecute(visitor.visitNoteRegionBoxAdapter, this)}

    onSelected(): void {
        this.#isSelected = true
        this.#dispatchChange()
    }

    onDeselected(): void {
        this.#isSelected = false
        this.#dispatchChange()
    }

    get isSelected(): boolean {return this.#isSelected}

    * iterateActiveNotesAt(position: ppqn): IterableIterator<NoteEvent> {
        const optCollection = this.optCollection
        if (optCollection.isEmpty()) {return}
        const collection = optCollection.unwrap()
        const local = LoopableRegion.globalToLocal(this, position)
        for (const event of collection.events.iterateFrom(local - collection.maxDuration)) {
            if (local < event.position) { return }
            if (local < event.complete) {
                yield event.copyAsNoteEvent()
            }
        }
    }

    terminate(): void {
        this.#eventCollectionSubscription.terminate()
        this.#terminator.terminate()
    }

    get box(): NoteRegionBox {return this.#box}
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
    get hasCollection() {return this.optCollection.nonEmpty()}
    get optCollection(): Option<NoteEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, NoteEventCollectionBoxAdapter))
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

    copyTo(params?: CopyToParams): NoteRegionBoxAdapter {
        const eventCollection = this.optCollection.unwrap("Cannot make copy without event-collection")
        const eventTarget = params?.consolidate === true
            ? eventCollection.copy().box.owners
            : eventCollection.box.owners
        return this.#context.boxAdapters.adapterFor(NoteRegionBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.position.setValue(params?.position ?? this.position)
            box.duration.setValue(params?.duration ?? this.duration)
            box.loopOffset.setValue(params?.loopOffset ?? this.loopOffset)
            box.loopDuration.setValue(params?.loopDuration ?? this.loopDuration)
            box.hue.setValue(this.hue)
            box.label.setValue(this.label)
            box.mute.setValue(this.mute)
            box.events.refer(eventTarget)
            box.regions.refer(params?.target ?? this.#box.regions.targetVertex.unwrap())
        }), NoteRegionBoxAdapter)
    }

    consolidate(): void {
        if (!this.isMirrowed) {return}
        this.optCollection.ifSome(source => {
            const graph = this.#context.boxGraph
            const target = NoteEventCollectionBox.create(graph, UUID.generate())
            source.events.asArray().forEach(adapter => adapter.copyTo({events: target.events}))
            this.#box.events.refer(target.owners)
        })
    }

    canFlatten(regions: ReadonlyArray<RegionBoxAdapter<unknown>>): boolean {
        return regions.length > 0 && Arrays.satisfy(regions, (a, b) => a.trackBoxAdapter.contains(b.trackBoxAdapter.unwrap()))
            && regions.every(region => region.isSelected && region instanceof NoteRegionBoxAdapter)
    }

    flatten(regions: ReadonlyArray<RegionBoxAdapter<unknown>>): Option<NoteRegionBox> {
        if (!this.canFlatten(regions)) {return Option.None}
        const graph = this.#context.boxGraph
        const sorted = regions.toSorted(RegionCollection.Comparator)
        const first = Arrays.getFirst(sorted, "Internal error (no first)")
        const last = Arrays.getLast(sorted, "Internal error (no last)")
        const rangeMin = first.position
        const rangeMax = last.position + last.duration
        const trackBoxAdapter = first.trackBoxAdapter.unwrap()
        const collectionBox = NoteEventCollectionBox.create(graph, UUID.generate())
        const overlapping = Array.from(trackBoxAdapter.regions.collection.iterateRange(rangeMin, rangeMax))
        overlapping
            .filter(region => region.isSelected)
            .forEach(anyRegion => {
                    const region = anyRegion as NoteRegionBoxAdapter // we made that sure in canFlatten
                    for (const {
                        resultStart,
                        resultEnd,
                        rawStart
                    } of LoopableRegion.locateLoops(region, region.position, region.complete)) {
                        const searchStart = Math.floor(resultStart - rawStart)
                        const searchEnd = Math.floor(resultEnd - rawStart)
                        for (const event of region.optCollection.unwrap().events.iterateRange(searchStart, searchEnd)) {
                            event.copyTo({
                                position: event.position + rawStart - first.position,
                                events: collectionBox.events
                            })
                        }
                    }
                }
            )
        overlapping.forEach(({box}) => box.delete())
        return Option.wrap(NoteRegionBox.create(graph, UUID.generate(), box => {
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

    toString(): string {return `{NoteRegionBoxAdapter ${UUID.toString(this.#box.address.uuid)} p: ${PPQN.toString(this.position)}, c: ${PPQN.toString(this.complete)}}`}

    #dispatchChange(): void {
        this.#changeNotifier.notify()
        this.trackBoxAdapter.unwrapOrNull()?.regions?.dispatchChange()
    }
}