import {
    AnyRegionBoxAdapter,
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
import {mod, Observer, Option, Subscription, Terminable} from "@opendaw/lib-std"
import {Propagation} from "@opendaw/lib-box"
import {RegionModifyStrategy, TimelineRange} from "@opendaw/studio-core"
import {deferNextFrame} from "@opendaw/lib-dom"
import {RegionModifyContext} from "@/ui/timeline/editors/RegionModifyContext.ts"

export class RegionReader<REGION extends LoopableRegionBoxAdapter<CONTENT> & AnyRegionBoxAdapter, CONTENT>
    implements EventOwnerReader<CONTENT> {
    static forAudioRegionBoxAdapter(region: AudioRegionBoxAdapter,
                                    timelineBoxAdapter: TimelineBoxAdapter,
                                    context?: RegionModifyContext): AudioEventOwnerReader {
        return new class extends RegionReader<AudioRegionBoxAdapter, ValueEventCollectionBoxAdapter>
            implements AudioEventOwnerReader {
            constructor(region: AudioRegionBoxAdapter) {super(region, timelineBoxAdapter, context)}
            get audioContent(): AudioContentBoxAdapter {return region}
        }(region)
    }

    static forNoteRegionBoxAdapter(adapter: NoteRegionBoxAdapter,
                                   timelineBoxAdapter: TimelineBoxAdapter,
                                   context?: RegionModifyContext): NoteEventOwnerReader {
        return new RegionReader<NoteRegionBoxAdapter, NoteEventCollectionBoxAdapter>(
            adapter, timelineBoxAdapter, context)
    }

    static forValueRegionBoxAdapter(adapter: ValueRegionBoxAdapter,
                                    timelineBoxAdapter: TimelineBoxAdapter,
                                    context?: RegionModifyContext): ValueEventOwnerReader {
        return new RegionReader<ValueRegionBoxAdapter, ValueEventCollectionBoxAdapter>(
            adapter, timelineBoxAdapter, context)
    }

    constructor(readonly region: REGION,
                readonly timelineBoxAdapter: TimelineBoxAdapter,
                readonly context: RegionModifyContext = RegionModifyContext.Idle) {}

    get position(): number {return this.#strategy().readPosition(this.region)}
    get duration(): number {return this.complete - this.position}
    get complete(): number {return this.#strategy().readComplete(this.region)}
    get loopOffset(): number {return this.#strategy().readLoopOffset(this.region)}
    get loopDuration(): number {return this.#strategy().readLoopDuration(this.region)}
    get contentDuration(): ppqn {return this.loopDuration}
    set contentDuration(value: ppqn) {this.region.loopDuration = Math.max(PPQN.SemiQuaver, value)}
    get hue(): number {return this.region.hue}
    get mute(): boolean {return this.region.mute}
    get offset(): number {return this.position - this.loopOffset}
    get canLoop(): boolean {return true}
    get hasContent(): boolean {return this.region.hasCollection}
    get isMirrored(): boolean {return this.region.isMirrowed}
    get content(): CONTENT {return this.region.optCollection.unwrap("optCollection")}
    get trackBoxAdapter(): Option<TrackBoxAdapter> {return this.region.trackBoxAdapter}

    subscribeChange(observer: Observer<void>): Subscription {
        return Terminable.many(this.region.subscribeChange(observer), this.context.subscribeUpdate(observer))
    }
    subscribeTrackChange(observer: Observer<void>): Subscription {return this.region.box.regions.subscribe(() => observer())}
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
                    case update.matches(region.box.loopOffset): {
                        run.request()
                        return
                    }
                }
            }
        })
    }
    mapPlaybackCursor(value: ppqn): ppqn {
        if (value < this.position || value >= this.complete) {
            return value
        }
        return mod(value - this.offset, this.loopDuration) + this.offset
    }

    #strategy(): RegionModifyStrategy {return this.context.strategyFor(this.region)}
}