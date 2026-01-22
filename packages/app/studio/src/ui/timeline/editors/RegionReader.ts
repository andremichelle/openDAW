import {
    AudioContentBoxAdapter,
    AudioRegionBoxAdapter,
    LoopableRegionBoxAdapter,
    NoteEventCollectionBoxAdapter,
    NoteRegionBoxAdapter,
    TimelineBoxAdapter,
    TrackBoxAdapter,
    ValueEventCollectionBoxAdapter,
    ValueRegionBoxAdapter
} from "@opendaw/studio-adapters"
import {
    AudioEventOwnerReader,
    EventOwnerReader,
    NoteEventOwnerReader,
    ValueEventOwnerReader
} from "@/ui/timeline/editors/EventOwnerReader.ts"
import {PPQN, ppqn} from "@opendaw/lib-dsp"
import {mod, Observer, Option, Subscription} from "@opendaw/lib-std"
import {Propagation} from "@opendaw/lib-box"
import {TimelineRange} from "@opendaw/studio-core"
import {deferNextFrame} from "@opendaw/lib-dom"

export class RegionReader<REGION extends LoopableRegionBoxAdapter<CONTENT>, CONTENT> implements EventOwnerReader<CONTENT> {
    static forAudioRegionBoxAdapter(region: AudioRegionBoxAdapter,
                                    timelineBoxAdapter: TimelineBoxAdapter): AudioEventOwnerReader {
        return new class extends RegionReader<AudioRegionBoxAdapter, ValueEventCollectionBoxAdapter>
            implements AudioEventOwnerReader {
            constructor(region: AudioRegionBoxAdapter) {super(region, timelineBoxAdapter)}
            get audioContent(): AudioContentBoxAdapter {return region}
        }(region)
    }

    static forNoteRegionBoxAdapter(adapter: NoteRegionBoxAdapter,
                                   timelineBoxAdapter: TimelineBoxAdapter): NoteEventOwnerReader {
        return new RegionReader<NoteRegionBoxAdapter, NoteEventCollectionBoxAdapter>(adapter, timelineBoxAdapter)
    }

    static forValueRegionBoxAdapter(adapter: ValueRegionBoxAdapter,
                                    timelineBoxAdapter: TimelineBoxAdapter): ValueEventOwnerReader {
        return new RegionReader<ValueRegionBoxAdapter, ValueEventCollectionBoxAdapter>(adapter, timelineBoxAdapter)
    }

    constructor(readonly region: REGION, readonly timelineBoxAdapter: TimelineBoxAdapter) {}

    get position(): number {return this.region.position}
    get duration(): number {return this.region.duration}
    get complete(): number {return this.region.position + this.region.duration}
    get loopOffset(): number {return this.region.loopOffset}
    get loopDuration(): number {return this.region.loopDuration}
    get contentDuration(): ppqn {return this.region.loopDuration}
    set contentDuration(value: ppqn) {this.region.loopDuration = Math.max(PPQN.SemiQuaver, value)}
    get hue(): number {return this.region.hue}
    get mute(): boolean {return this.region.mute}
    get offset(): number {return this.region.offset}
    get canLoop(): boolean {return true}
    get hasContent(): boolean {return this.region.hasCollection}
    get isMirrored(): boolean {return this.region.isMirrowed}
    get content(): CONTENT {return this.region.optCollection.unwrap()}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {return this.region.trackBoxAdapter}

    subscribeChange(observer: Observer<void>): Subscription {return this.region.subscribeChange(observer)}
    keeoOverlapping(range: TimelineRange): Subscription {
        const region = this.region
        const run = deferNextFrame(() => {
            let unit = range.unitMin
            if (region.offset + region.loopDuration > range.unitMax) {
                const paddingRight = range.unitPadding * 2
                unit = (region.offset + region.loopDuration + paddingRight) - range.unitRange
            }
            if (region.offset < range.unitMin) {
                unit = region.offset
            }
            range.moveToUnit(unit)
        })
        return region.box.subscribe(Propagation.Children, update => {
            if (update.type === "primitive") {
                switch (true) {
                    case update.matches(region.box.position):
                    case update.matches(region.box.duration):
                    case update.matches(region.box.loopOffset):
                    case update.matches(region.box.loopDuration): {
                        run.request()
                        return
                    }
                }
            }
        })
    }
    mapPlaybackCursor(value: ppqn): ppqn {
        if (value < this.position || value > this.complete) {
            return value
        }
        return mod(value - this.offset, this.loopDuration) + this.offset
    }
}