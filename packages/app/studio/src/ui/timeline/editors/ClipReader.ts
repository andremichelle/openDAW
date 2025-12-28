import {
    AudioClipBoxAdapter,
    AudioContentBoxAdapter,
    ClipBoxAdapter,
    NoteClipBoxAdapter,
    NoteEventCollectionBoxAdapter,
    TimelineBoxAdapter,
    TrackBoxAdapter,
    ValueClipBoxAdapter,
    ValueEventCollectionBoxAdapter
} from "@opendaw/studio-adapters"
import {ppqn} from "@opendaw/lib-dsp"
import {mod, Observer, Option, Subscription} from "@opendaw/lib-std"
import {TimelineRange} from "@opendaw/studio-core"
import {Propagation} from "@opendaw/lib-box"
import {
    AudioEventOwnerReader,
    EventOwnerReader,
    NoteEventOwnerReader,
    ValueEventOwnerReader
} from "@/ui/timeline/editors/EventOwnerReader.ts"

export class ClipReader<CONTENT> implements EventOwnerReader<CONTENT> {
    static forAudioClipBoxAdapter(clip: AudioClipBoxAdapter, timelineBoxAdapter: TimelineBoxAdapter): AudioEventOwnerReader {
        return new class extends ClipReader<never> implements AudioEventOwnerReader {
            constructor(clip: AudioClipBoxAdapter) {super(clip, timelineBoxAdapter)}
            get audioContent(): AudioContentBoxAdapter {return clip}
        }(clip)
    }

    static forNoteClipBoxAdapter(adapter: NoteClipBoxAdapter,
                                 timelineBoxAdapter: TimelineBoxAdapter): NoteEventOwnerReader {
        return new ClipReader<NoteEventCollectionBoxAdapter>(adapter, timelineBoxAdapter)
    }

    static forValueClipBoxAdapter(adapter: ValueClipBoxAdapter,
                                  timelineBoxAdapter: TimelineBoxAdapter): ValueEventOwnerReader {
        return new ClipReader<ValueEventCollectionBoxAdapter>(adapter, timelineBoxAdapter)
    }

    constructor(readonly clip: ClipBoxAdapter<CONTENT>, readonly timelineBoxAdapter: TimelineBoxAdapter) {}

    get position(): number {return 0}
    get duration(): number {return this.clip.duration}
    get complete(): number {return this.clip.duration}
    get loopOffset(): number {return 0}
    get loopDuration(): number {return this.clip.duration}
    get contentDuration(): ppqn {return this.clip.duration}
    set contentDuration(value: ppqn) {this.clip.box.duration.setValue(value)}
    get hue(): number {return this.clip.hue}
    get mute(): boolean {return this.clip.mute}
    get offset(): number {return 0}
    get canLoop(): boolean {return true}
    get hasContent(): boolean {return this.clip.hasCollection}
    get isMirrored(): boolean {return this.clip.isMirrowed}
    get content(): CONTENT {return this.clip.optCollection.unwrap()}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {return this.clip.trackBoxAdapter}

    subscribeChange(observer: Observer<void>): Subscription {return this.clip.subscribeChange(observer)}
    keeoOverlapping(range: TimelineRange): Subscription {
        const clip = this.clip
        return clip.box.subscribe(Propagation.Children, update => {
                if (update.type === "primitive") {
                    switch (true) {
                        case update.matches(clip.box.duration):
                            let unit = range.unitMin
                            if (clip.duration > range.unitMax) {
                                const paddingRight = range.unitPadding * 2
                                unit = (clip.duration + paddingRight) - range.unitRange
                            }
                            if (range.unitMin > 0) {
                                unit = 0
                            }
                            range.moveToUnit(unit)
                            return
                    }
                }
            }
        )
    }
    mapPlaybackCursor(value: ppqn): ppqn {return mod(value, this.loopDuration)}
}