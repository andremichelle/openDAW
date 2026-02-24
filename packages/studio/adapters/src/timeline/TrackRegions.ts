import {RegionCollection} from "@opendaw/lib-dsp"
import {assert, Listeners, Notifier, Observer, SortedSet, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {TrackBoxAdapter} from "./TrackBoxAdapter"
import {AnyRegionBoxAdapter} from "../UnionAdapterTypes"
import {BoxAdapters} from "../BoxAdapters"
import {RegionAdapters, RegionComparator} from "./RegionBoxAdapter"

export interface TrackRegionsListener {
    onAdded(region: AnyRegionBoxAdapter): void
    onRemoved(region: AnyRegionBoxAdapter): void
}

export class TrackRegions {
    readonly #trackBoxAdapter: TrackBoxAdapter

    readonly #terminator: Terminator
    readonly #changeNotifier: Notifier<void>
    readonly #regionsListeners: Listeners<TrackRegionsListener>
    readonly #collection: RegionCollection<AnyRegionBoxAdapter>
    readonly #adapters: SortedSet<UUID.Bytes, AnyRegionBoxAdapter>

    #overlapCheckPending: boolean = false

    constructor(adapter: TrackBoxAdapter, boxAdapters: BoxAdapters) {
        this.#trackBoxAdapter = adapter

        this.#terminator = new Terminator()
        this.#changeNotifier = this.#terminator.own(new Notifier<void>())
        this.#regionsListeners = this.#terminator.own(new Listeners<TrackRegionsListener>())
        this.#collection = RegionCollection.create<AnyRegionBoxAdapter>(RegionComparator)
        this.#adapters = UUID.newSet<AnyRegionBoxAdapter>(adapter => adapter.uuid)
        this.#terminator.ownAll(
            this.#trackBoxAdapter.box.regions.pointerHub.catchupAndSubscribe({
                onAdded: ({box}) => {
                    const adapter = RegionAdapters.for(boxAdapters, box)
                    const added = this.#adapters.add(adapter)
                    assert(added, `Cannot add ${box}`)
                    this.#collection.add(adapter)
                    for (const existing of this.#collection.iterateRange(adapter.position, adapter.complete)) {
                        if (existing !== adapter && existing.position < adapter.complete && existing.complete > adapter.position) {
                            console.warn("[TrackRegions] Overlapping region added", {
                                track: this.#trackBoxAdapter.listIndex,
                                added: {p: adapter.position, d: adapter.duration, c: adapter.complete},
                                existing: {p: existing.position, d: existing.duration, c: existing.complete},
                                stack: new Error().stack
                            })
                            break
                        }
                    }
                    this.#regionsListeners.forEach(listener => listener.onAdded(adapter))
                    this.dispatchChange()
                },
                onRemoved: ({box: {address: {uuid}}}) => {
                    const adapter = this.#adapters.removeByKey(uuid)
                    this.#collection.remove(adapter)
                    this.#regionsListeners.forEach(listener => listener.onRemoved(adapter))
                    this.dispatchChange()
                }
            }, Pointers.RegionCollection)
        )
    }

    get trackBoxAdapter(): TrackBoxAdapter {return this.#trackBoxAdapter}
    get collection(): RegionCollection<AnyRegionBoxAdapter> {return this.#collection}
    get adapters(): SortedSet<Readonly<Uint8Array>, AnyRegionBoxAdapter> {return this.#adapters}

    onIndexingChanged(): void {
        this.#collection.onIndexingChanged()
        if (!this.#overlapCheckPending) {
            this.#overlapCheckPending = true
            const stack = new Error().stack
            queueMicrotask(() => {
                this.#overlapCheckPending = false
                const regions = this.#collection.asArray()
                for (let i = 1; i < regions.length; i++) {
                    const prev = regions[i - 1]
                    const next = regions[i]
                    if (prev.complete > next.position) {
                        console.error("[TrackRegions] Overlap after position change", {
                            track: this.#trackBoxAdapter.listIndex,
                            prev: {p: prev.position, d: prev.duration, c: prev.complete, type: prev.toString()},
                            next: {p: next.position, d: next.duration, c: next.complete, type: next.toString()},
                            allRegions: regions.map(region => ({
                                p: region.position, d: region.duration, c: region.complete, sel: region.isSelected
                            })),
                            stack
                        })
                        break
                    }
                }
            })
        }
        this.dispatchChange()
    }

    catchupAndSubscribe(listener: TrackRegionsListener): Subscription {
        this.collection.asArray().forEach(listener.onAdded)
        return this.#regionsListeners.subscribe(listener)
    }

    subscribeChanges(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}
    dispatchChange(): void {this.#changeNotifier.notify()}
    terminate() {this.#terminator.terminate()}
}