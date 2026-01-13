import {ppqn} from "@moises-ai/lib-dsp"
import {int, Observer, Option, Subscription} from "@moises-ai/lib-std"
import {TimeAxisCursorMapper} from "@/ui/timeline/TimeAxis.tsx"
import {
    AudioContentBoxAdapter,
    NoteEventCollectionBoxAdapter,
    TimelineBoxAdapter,
    TrackBoxAdapter,
    ValueEventCollectionBoxAdapter
} from "@moises-ai/studio-adapters"
import {TimelineRange} from "@moises-ai/studio-core"

export interface AudioEventOwnerReader extends EventOwnerReader<ValueEventCollectionBoxAdapter> {
    get audioContent(): AudioContentBoxAdapter
}

export interface NoteEventOwnerReader extends EventOwnerReader<NoteEventCollectionBoxAdapter> {}

export interface ValueEventOwnerReader extends EventOwnerReader<ValueEventCollectionBoxAdapter> {}

export interface EventOwnerReader<CONTENT> extends TimeAxisCursorMapper {
    get position(): ppqn
    get duration(): ppqn
    get loopOffset(): ppqn
    get loopDuration(): ppqn
    get contentDuration(): ppqn
    set contentDuration(value: ppqn)
    get offset(): ppqn
    get complete(): ppqn
    get hue(): int
    get mute(): boolean
    get canLoop(): boolean
    get hasContent(): boolean
    get isMirrored(): boolean
    get content(): CONTENT
    get trackBoxAdapter(): Option<TrackBoxAdapter>
    get timelineBoxAdapter(): TimelineBoxAdapter

    subscribeChange(observer: Observer<void>): Subscription
    keeoOverlapping(range: TimelineRange): Subscription
}