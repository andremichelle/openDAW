import {
    DefaultObservableValue,
    int,
    Maybe,
    Notifier,
    ObservableValue,
    Observer,
    Option,
    safeExecute,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {EventCollection, ppqn, PPQN} from "@moises-ai/lib-dsp"
import {Address, Int32Field, Propagation, Update} from "@moises-ai/lib-box"
import {NoteClipBox} from "@moises-ai/studio-boxes"
import {NoteEventCollectionBoxAdapter} from "../collection/NoteEventCollectionBoxAdapter"
import {ClipBoxAdapter, ClipBoxAdapterVisitor} from "../ClipBoxAdapter"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {NoteEventBoxAdapter} from "../event/NoteEventBoxAdapter"
import {TrackBoxAdapter} from "../TrackBoxAdapter"

export class NoteClipBoxAdapter implements ClipBoxAdapter<NoteEventCollectionBoxAdapter> {
    readonly type = "note-clip"

    readonly #terminator: Terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: NoteClipBox

    readonly #selectedValue: DefaultObservableValue<boolean>
    readonly #changeNotifier: Notifier<void>

    readonly #isConstructing: boolean // Prevents stack overflow due to infinite adapter queries

    #eventCollectionSubscription: Subscription = Terminable.Empty

    constructor(context: BoxAdaptersContext, box: NoteClipBox) {
        this.#context = context
        this.#box = box

        this.#isConstructing = true
        this.#selectedValue = this.#terminator.own(new DefaultObservableValue(false))
        this.#changeNotifier = this.#terminator.own(new Notifier<void>())
        this.#terminator.ownAll(
            this.#box.pointerHub.subscribe({
                onAdded: () => this.#dispatchChange(),
                onRemoved: () => this.#dispatchChange()
            }),
            this.#box.subscribe(Propagation.Children, (_update: Update) => this.#dispatchChange()),
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

    catchupAndSubscribeSelected(observer: Observer<ObservableValue<boolean>>): Subscription {
        return this.#selectedValue.catchupAndSubscribe(observer)
    }

    subscribeChange(observer: Observer<void>): Subscription {return this.#changeNotifier.subscribe(observer)}
    accept<R>(visitor: ClipBoxAdapterVisitor<R>): Maybe<R> {return safeExecute(visitor.visitNoteClipBoxAdapter, this)}

    consolidate(): void {
        if (this.isMirrowed) {this.#box.events.refer(this.optCollection.unwrap().copy().box.owners)}
    }

    clone(consolidate: boolean): void {
        const events = consolidate ? this.optCollection.unwrap().copy().box.owners : this.#box.events.targetVertex.unwrap()
        NoteClipBox.create(this.#context.boxGraph, UUID.generate(), box => {
            box.index.setValue(this.indexField.getValue())
            box.label.setValue(this.label)
            box.hue.setValue(this.hue)
            box.duration.setValue(this.duration)
            box.mute.setValue(this.mute)
            box.clips.refer(this.#box.clips.targetVertex.unwrap())
            box.events.refer(events)
        })
    }

    onSelected(): void {this.#selectedValue.setValue(true)}
    onDeselected(): void {this.#selectedValue.setValue(false)}

    get isSelected(): boolean {return this.#selectedValue.getValue()}

    terminate(): void {
        this.#eventCollectionSubscription.terminate()
        this.#terminator.terminate()
    }

    get box(): NoteClipBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get duration(): ppqn {return this.#box.duration.getValue()}
    get mute(): boolean {return this.#box.mute.getValue()}
    get hue(): int {return this.#box.hue.getValue()}
    get events(): Option<EventCollection<NoteEventBoxAdapter>> {
        return this.optCollection.map(collection => collection.events)
    }
    get hasCollection() {return !this.optCollection.isEmpty()}
    get optCollection(): Option<NoteEventCollectionBoxAdapter> {
        return this.#box.events.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, NoteEventCollectionBoxAdapter))
    }
    get label(): string {return this.#box.label.getValue()}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {
        if (this.#isConstructing) {return Option.None}
        return this.#box.clips.targetVertex
            .map(vertex => this.#context.boxAdapters.adapterFor(vertex.box, TrackBoxAdapter))
    }
    get isMirrowed(): boolean {return this.optCollection.mapOr(adapter => adapter.numOwners > 1, false)}
    get canMirror(): boolean {return true}

    toString(): string {return `{NoteClipBoxAdapter ${UUID.toString(this.#box.address.uuid)} d: ${PPQN.toString(this.duration)}}`}

    #dispatchChange(): void {
        this.#changeNotifier.notify()
        this.trackBoxAdapter.unwrapOrNull()?.clips?.dispatchChange()
    }
}