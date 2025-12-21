import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {ppqn} from "@opendaw/lib-dsp"
import {TimelineBoxAdapter, TrackBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {int, Observer, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {TimelineRange} from "@opendaw/studio-core"

export class TempoValueEventOwnerReader implements ValueEventOwnerReader {
    readonly #adapter: TimelineBoxAdapter

    constructor(adapter: TimelineBoxAdapter) {
        this.#adapter = adapter
    }

    get content(): ValueEventCollectionBoxAdapter {return this.#adapter.tempoTrackEvents.unwrap()}
    get contentDuration(): ppqn {return Number.POSITIVE_INFINITY}
    get hasContent(): boolean {return this.#adapter.tempoTrackEvents.nonEmpty()}
    get hue(): int {return 30}
    get isMirrored(): boolean {return false}
    get offset(): ppqn {return 0}
    get position(): ppqn {return 0}
    get duration(): ppqn {return Number.POSITIVE_INFINITY}
    get complete(): ppqn {return Number.POSITIVE_INFINITY}
    get loopDuration(): ppqn {return Number.POSITIVE_INFINITY}
    get loopOffset(): ppqn {return 0}
    get mute(): boolean {return !this.#adapter.box.tempoTrack.enabled.getValue()}
    get canLoop(): boolean {return false}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {return Option.None}
    keeoOverlapping(_range: TimelineRange): Subscription {
        return Terminable.Empty
    }
    mapPlaybackCursor(position: ppqn): ppqn {return position}
    subscribeChange(observer: Observer<void>): Subscription {
        let inner: Subscription = Terminable.Empty
        return Terminable.many(
            this.#adapter.tempoTrackEvents.catchupAndSubscribe(option => {
                inner.terminate()
                observer()
                inner = option.mapOr(collection => collection.subscribeChange(() => observer()), Terminable.Empty)
            }),
            this.#adapter.box.tempoTrack.minBpm.subscribe(() => observer()),
            this.#adapter.box.tempoTrack.maxBpm.subscribe(() => observer()),
            this.#adapter.box.tempoTrack.enabled.subscribe(() => observer()),
            this.#adapter.box.bpm.subscribe(() => observer()),
            {terminate: () => inner.terminate()}
        )
    }
}