import {TimelineBox} from "@opendaw/studio-boxes"
import {
    int,
    MutableObservableOption,
    Notifier,
    ObservableOption,
    Observer,
    Option,
    Subscription,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {BoxAdapter} from "../BoxAdapter"
import {MarkerTrackAdapter} from "./MarkerTrackAdapter"
import {SignatureTrackAdapter} from "./SignatureTrackAdapter"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {ValueEventCollectionBoxAdapter} from "./collection/ValueEventCollectionBoxAdapter"

export class TimelineBoxAdapter implements BoxAdapter {
    readonly #terminator = new Terminator()

    readonly #box: TimelineBox

    readonly #markerTrack: MarkerTrackAdapter
    readonly #signatureTrack: SignatureTrackAdapter
    readonly #tempoTrackEvents: MutableObservableOption<ValueEventCollectionBoxAdapter>
    readonly #tempoAutomation: Notifier<Option<ValueEventCollectionBoxAdapter>>

    constructor(context: BoxAdaptersContext, box: TimelineBox) {
        this.#box = box

        this.#markerTrack = new MarkerTrackAdapter(context, this.#box.markerTrack)
        this.#signatureTrack = new SignatureTrackAdapter(context, this.#box.signatureTrack)
        this.#tempoTrackEvents = new MutableObservableOption<ValueEventCollectionBoxAdapter>()
        this.#tempoAutomation = new Notifier<Option<ValueEventCollectionBoxAdapter>>()

        const tempoAutomationLifecycle = this.#terminator.own(new Terminator())
        const updateTempoAutomation = (): void => this.#tempoAutomation.notify(this.#resolveTempoAutomation())
        const {tempoTrack: {events, enabled}} = box
        this.#terminator.own(events.catchupAndSubscribe(({targetVertex}) => {
            tempoAutomationLifecycle.terminate()
            targetVertex.match({
                none: () => this.#tempoTrackEvents.clear(),
                some: ({box}) => {
                    const eventCollectionAdapter = context.boxAdapters.adapterFor(box, ValueEventCollectionBoxAdapter)
                    this.#tempoTrackEvents.wrap(eventCollectionAdapter)
                    tempoAutomationLifecycle.ownAll(
                        eventCollectionAdapter.subscribeChange(updateTempoAutomation),
                        enabled.subscribe(updateTempoAutomation)
                    )
                }
            })
        }))
    }

    // For dsp. It does not care why events are not available. We just send Option.None if disabled or no events present.
    catchupAndSubscribeTempoAutomation(observer: Observer<Option<ValueEventCollectionBoxAdapter>>): Subscription {
        observer(this.#resolveTempoAutomation())
        return this.#tempoAutomation.subscribe(observer)
    }

    get box(): TimelineBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get markerTrack(): MarkerTrackAdapter {return this.#markerTrack}
    get signatureTrack(): SignatureTrackAdapter {return this.#signatureTrack}
    get tempoTrackEvents(): ObservableOption<ValueEventCollectionBoxAdapter> {return this.#tempoTrackEvents}
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

    #resolveTempoAutomation = (): Option<ValueEventCollectionBoxAdapter> => {
        const {tempoTrack: {enabled}} = this.#box
        if (!enabled.getValue()) {
            return Option.None
        } else if (this.#tempoTrackEvents.isEmpty()) {
            return Option.None
        } else if (this.#tempoTrackEvents.unwrap().events.isEmpty()) {
            return Option.None
        } else {
            return (this.#tempoTrackEvents)
        }
    }
}