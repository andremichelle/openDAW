import {int, Notifier, Observer, Option, panic, SortedSet, Subscription, Terminable, UUID} from "@moises-ai/lib-std"
import {Pointers} from "@moises-ai/studio-enums"
import {TrackBox} from "@moises-ai/studio-boxes"
import {Vertex} from "@moises-ai/lib-box"
import {AudioUnitBoxAdapter} from "./AudioUnitBoxAdapter"
import {IndexedAdapterCollectionListener, IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {TrackBoxAdapter} from "../timeline/TrackBoxAdapter"
import {BoxAdapters} from "../BoxAdapters"
import {TrackType} from "../timeline/TrackType"

export class AudioUnitTracks implements Terminable {
    readonly #adapter: AudioUnitBoxAdapter

    readonly #regionNotifier: Notifier<void> = new Notifier<void>()
    readonly #collection: IndexedBoxAdapterCollection<TrackBoxAdapter, Pointers.TrackCollection>
    readonly #subscriptions: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, subscription: Subscription }>
    readonly #subscription: Subscription

    constructor(adapter: AudioUnitBoxAdapter, boxAdapters: BoxAdapters) {
        this.#adapter = adapter
        this.#collection = IndexedBoxAdapterCollection.create(adapter.box.tracks,
            box => boxAdapters.adapterFor(box, TrackBoxAdapter), Pointers.TrackCollection)
        this.#subscriptions = UUID.newSet(({uuid}) => uuid)
        this.#subscription = this.#collection.catchupAndSubscribe({
            onAdd: (adapter: TrackBoxAdapter) => this.#subscriptions.add({
                uuid: adapter.uuid,
                subscription: adapter.regions.subscribeChanges(() => this.#regionNotifier.notify())
            }),
            onRemove: ({uuid}: TrackBoxAdapter) => this.#subscriptions.removeByKey(uuid).subscription.terminate(),
            onReorder: (_adapter: TrackBoxAdapter) => {}
        })
    }

    create(type: TrackType, target: Vertex<Pointers.Automation | Pointers>, index?: int): void {
        const graph = this.#adapter.box.graph
        const tracks = this.#adapter.box.tracks
        TrackBox.create(graph, UUID.generate(), box => {
            box.index.setValue(index ?? this.#collection.getMinFreeIndex())
            box.type.setValue(type)
            box.tracks.refer(tracks)
            box.target.refer(target)
        })
    }

    controls(target: Vertex<Pointers.Automation | Pointers>): Option<TrackBoxAdapter> {
        return Option.wrap(this.#collection.adapters()
            .find(adapter => adapter.target.targetVertex.contains(target), false))
    }

    delete(adapter: TrackBoxAdapter): void {
        const adapters = this.#collection.adapters()
        const deleteIndex = adapters.indexOf(adapter)
        if (deleteIndex === -1) {return panic(`Cannot delete ${adapter}. Does not exist.`)}
        for (let index = deleteIndex + 1; index < adapters.length; index++) {
            adapters[index].indexField.setValue(index - 1)
        }
        adapter.box.delete()
    }

    get collection(): IndexedBoxAdapterCollection<TrackBoxAdapter, Pointers.TrackCollection> {return this.#collection}

    values(): ReadonlyArray<TrackBoxAdapter> {return this.#collection.adapters()}

    catchupAndSubscribe(listener: IndexedAdapterCollectionListener<TrackBoxAdapter>): Subscription {
        return this.#collection.catchupAndSubscribe(listener)
    }

    subscribeAnyChange(observer: Observer<void>): Subscription {return this.#regionNotifier.subscribe(observer)}

    terminate(): void {
        this.#collection.terminate()
        this.#subscription.terminate()
        this.#subscriptions.forEach(({subscription}) => subscription.terminate())
        this.#subscriptions.clear()
    }
}