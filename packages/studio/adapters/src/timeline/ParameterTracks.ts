import {int, Notifier, Observer, Option, panic, SortedSet, Subscription, Terminable, UUID} from "@opendaw/lib-std"
import {Pointers} from "@opendaw/studio-enums"
import {TrackBox} from "@opendaw/studio-boxes"
import {BoxGraph, Field, Vertex} from "@opendaw/lib-box"
import {IndexedAdapterCollectionListener, IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {TrackBoxAdapter} from "./TrackBoxAdapter"
import {BoxAdapters} from "../BoxAdapters"
import {TrackType} from "./TrackType"

/// What a parameter needs from whatever owns its automation lanes. An audio unit is one owner, a modulator
/// is another, and neither is visible to the parameter itself.
export interface ParameterTracks extends Terminable {
    create(type: TrackType, target: Vertex<Pointers.Automation | Pointers>, index?: int): TrackBox
    controls(target: Vertex<Pointers.Automation | Pointers>): Option<TrackBoxAdapter>
    delete(adapter: TrackBoxAdapter): void
    values(): ReadonlyArray<TrackBoxAdapter>
    get collection(): IndexedBoxAdapterCollection<TrackBoxAdapter, Pointers.TrackCollection>
    catchupAndSubscribe(listener: IndexedAdapterCollectionListener<TrackBoxAdapter>): Subscription
    subscribeAnyChange(observer: Observer<void>): Subscription
}

export class FieldParameterTracks implements ParameterTracks {
    readonly #graph: BoxGraph
    readonly #field: Field<Pointers.TrackCollection>

    readonly #regionNotifier: Notifier<void> = new Notifier<void>()
    readonly #collection: IndexedBoxAdapterCollection<TrackBoxAdapter, Pointers.TrackCollection>
    readonly #subscriptions: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, subscription: Subscription }>
    readonly #subscription: Subscription

    constructor(graph: BoxGraph, field: Field<Pointers.TrackCollection>, boxAdapters: BoxAdapters) {
        this.#graph = graph
        this.#field = field
        this.#collection = IndexedBoxAdapterCollection.create(field,
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

    create(type: TrackType, target: Vertex<Pointers.Automation | Pointers>, index?: int): TrackBox {
        return TrackBox.create(this.#graph, UUID.generate(), box => {
            box.index.setValue(index ?? this.#collection.getMinFreeIndex())
            box.type.setValue(type)
            box.tracks.refer(this.#field)
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
