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
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {ValueEventCollectionBoxAdapter} from "./collection/ValueEventCollectionBoxAdapter"

export class TimelineBoxAdapter implements BoxAdapter {
    readonly #terminator = new Terminator()

    readonly #box: TimelineBox
    readonly #markerTrack: MarkerTrackAdapter
    readonly #tempoTrackEvents: MutableObservableOption<ValueEventCollectionBoxAdapter>
    readonly #tempoAutomation: Notifier<Option<ValueEventCollectionBoxAdapter>>

    constructor(context: BoxAdaptersContext, box: TimelineBox) {
        this.#box = box
        this.#markerTrack = new MarkerTrackAdapter(context, this.#box.markerTrack)
        this.#tempoTrackEvents = new MutableObservableOption<ValueEventCollectionBoxAdapter>()
        this.#tempoAutomation = new Notifier<Option<ValueEventCollectionBoxAdapter>>()

        const tempoAutomationLifecycle = this.#terminator.own(new Terminator())
        const {tempoTrack: {events, enabled}} = box
        const updateTempoAutomation = () => {
            if (!enabled.getValue()) {
                this.#tempoAutomation.notify(Option.None)
            } else if (this.#tempoTrackEvents.isEmpty()) {
                this.#tempoAutomation.notify(Option.None)
            } else if (this.#tempoTrackEvents.unwrap().events.isEmpty()) {
                this.#tempoAutomation.notify(Option.None)
            } else {
                this.#tempoAutomation.notify(this.#tempoTrackEvents)
            }
        }
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
            updateTempoAutomation()
        }))
    }

    get box(): TimelineBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get markerTrack(): MarkerTrackAdapter {return this.#markerTrack}
    get tempoTrackEvents(): ObservableOption<ValueEventCollectionBoxAdapter> {return this.#tempoTrackEvents}
    // For dsp. It does not care why events are not available. We just send Option.None if disabled or no events present.
    get tempoAutomation(): Notifier<Option<ValueEventCollectionBoxAdapter>> {return this.#tempoAutomation}
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