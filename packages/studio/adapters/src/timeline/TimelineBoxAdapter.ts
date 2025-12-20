import {TimelineBox} from "@opendaw/studio-boxes"
import {
    int,
    MutableObservableOption,
    ObservableOption,
    Observer,
    Subscription,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {BoxAdapter} from "../BoxAdapter"
import {MarkerTrackAdapter} from "./MarkerTrackAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {ValueEventCollectionBoxAdapter} from "./collection/ValueEventCollectionBoxAdapter"

export class TimelineBoxAdapter implements BoxAdapter {
    readonly #terminator = new Terminator()

    readonly #box: TimelineBox
    readonly #markerTrack: MarkerTrackAdapter
    readonly #tempoTrack: MutableObservableOption<ValueEventCollectionBoxAdapter>

    constructor(context: BoxAdaptersContext, box: TimelineBox) {
        this.#box = box
        this.#markerTrack = new MarkerTrackAdapter(context, this.#box.markerTrack)
        this.#tempoTrack = new MutableObservableOption<ValueEventCollectionBoxAdapter>()

        this.#terminator.own(this.#box.tempoTrack.events.catchupAndSubscribe(({targetVertex}) => {
            targetVertex.match({
                none: () => this.#tempoTrack.clear(),
                some: ({box}) => this.#tempoTrack.wrap(context.boxAdapters
                    .adapterFor(box, ValueEventCollectionBoxAdapter))
            })
        }))
    }

    get box(): TimelineBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get markerTrack(): MarkerTrackAdapter {return this.#markerTrack}
    get tempoTrack(): ObservableOption<ValueEventCollectionBoxAdapter> {return this.#tempoTrack}
    get signature(): Readonly<[int, int]> {
        const {nominator, denominator} = this.#box.signature
        return [nominator.getValue(), denominator.getValue()]
    }
    get signatureDuration(): ppqn {
        const {nominator, denominator} = this.#box.signature
        return PPQN.fromSignature(nominator.getValue(), denominator.getValue())
    }

    catchupAndSubscribeSignature(observer: Observer<Readonly<[int, int]>>): Subscription {
        observer(this.signature)
        return this.#box.signature.subscribe(() => observer(this.signature))
    }

    terminate(): void {this.#terminator.terminate()}
}