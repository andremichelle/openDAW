import {ValueEventOwnerReader} from "@/ui/timeline/editors/EventOwnerReader"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {TimelineBoxAdapter, TrackBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {int, Observer, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {TimelineRange} from "@opendaw/studio-core"

export class TempoValueEventOwnerReader implements ValueEventOwnerReader {
    readonly #adapter: TimelineBoxAdapter

    constructor(adapter: TimelineBoxAdapter) {this.#adapter = adapter}

    get content(): ValueEventCollectionBoxAdapter {return this.#adapter.tempoTrack.unwrap()}
    get contentDuration(): ppqn {return PPQN.Bar * 128}
    get hasContent(): boolean {return this.#adapter.tempoTrack.nonEmpty()}
    get hue(): int {return 30}
    get isMirrored(): boolean {return false}
    get offset(): ppqn {return 0}
    get position(): ppqn {return 0}
    get duration(): ppqn {return PPQN.Bar * 128}
    get complete(): ppqn {return PPQN.Bar * 128}
    get loopDuration(): ppqn {return PPQN.Bar * 128}
    get loopOffset(): ppqn {return 0}
    get mute(): boolean {return false}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {return Option.None}
    keeoOverlapping(_range: TimelineRange): Subscription {
        return Terminable.Empty
    }
    mapPlaybackCursor(position: ppqn): ppqn {return position}
    subscribeChange(observer: Observer<void>): Subscription {
        // TODO Use a notifier
        let inner: Subscription = Terminable.Empty
        return Terminable.many(
            this.#adapter.tempoTrack.catchupAndSubscribe(option => {
                inner.terminate()
                observer()
                inner = option.mapOr(
                    collection => collection.subscribeChange(() => observer()),
                    Terminable.Empty
                )
            }),
            {terminate: () => inner.terminate()}
        )
    }
}