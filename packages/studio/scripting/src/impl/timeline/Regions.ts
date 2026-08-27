import {
    AudioRegionBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {PPQN, ppqn, seconds, TimeBase} from "@opendaw/lib-dsp"
import {ColorCodes, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {asInstanceOf, float, int, isDefined, panic, Procedure, UUID} from "@opendaw/lib-std"
import {
    AudioFading,
    AudioPlayback,
    AudioRegion,
    AudioRegionProps,
    AudioTrack,
    NoteEvent,
    NoteEventProps,
    NoteRegion,
    NoteRegionProps,
    NoteTrack,
    Sample,
    ValueEvent,
    ValueEventProps,
    ValueRegion,
    ValueRegionProps,
    ValueTrack
} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Guard} from "../Guard"
import {NoteEvents, ValueEvents} from "./Events"
import {AudioContents} from "./AudioContents"
import {AudioFiles} from "../AudioFiles"
import {TrackImpls} from "./Tracks"
import {NoteClipImpl, ValueClipImpl} from "./Clips"

export type RegionBox = NoteRegionBox | AudioRegionBox | ValueRegionBox

export abstract class RegionFacade<B extends RegionBox> extends Facade<B> {
    declare position: ppqn
    declare duration: number
    declare mute: boolean
    declare label: string
    declare hue: int
    declare loopDuration: number
    declare loopOffset: number

    protected constructor(context: Context, box: B) {
        super(context, box)
        this.bind({
            position: box.position, duration: box.duration, mute: box.mute, label: box.label, hue: box.hue,
            loopDuration: box.loopDuration, loopOffset: box.loopOffset
        })
    }

    get complete(): number {return this.position + this.duration}

    get trackBox(): TrackBox {
        return asInstanceOf(this.box.regions.targetVertex.unwrap("region has no track").box, TrackBox)
    }
}

export class NoteRegionImpl extends RegionFacade<NoteRegionBox> implements NoteRegion {
    static wrap(context: Context, box: NoteRegionBox): NoteRegionImpl {
        return context.facade(box, () => new NoteRegionImpl(context, box))
    }

    declare eventOffset: ppqn

    private constructor(context: Context, box: NoteRegionBox) {
        super(context, box)
        this.bind({eventOffset: box.eventOffset})
    }

    get track(): NoteTrack {return TrackImpls.wrap(this.context, this.trackBox) as NoteTrack}
    get noteEvents(): NoteEvents {
        return new NoteEvents(this.context, asInstanceOf(this.box.events.targetVertex.unwrap("region has no events").box, NoteEventCollectionBox))
    }
    get events(): ReadonlyArray<NoteEvent> {return this.noteEvents.list()}
    addEvent(props?: NoteEventProps): NoteEvent {return this.noteEvents.add(props)}
    addEvents(events: ReadonlyArray<NoteEventProps>): ReadonlyArray<NoteEvent> {return this.noteEvents.addAll(events)}
    clearEvents(): void {this.noteEvents.clear()}
}

export class ValueRegionImpl extends RegionFacade<ValueRegionBox> implements ValueRegion {
    static wrap(context: Context, box: ValueRegionBox): ValueRegionImpl {
        return context.facade(box, () => new ValueRegionImpl(context, box))
    }

    private constructor(context: Context, box: ValueRegionBox) {super(context, box)}

    get track(): ValueTrack {return TrackImpls.wrap(this.context, this.trackBox) as ValueTrack}
    get valueEvents(): ValueEvents {
        return new ValueEvents(this.context, asInstanceOf(this.box.events.targetVertex.unwrap("region has no events").box, ValueEventCollectionBox))
    }
    get events(): ReadonlyArray<ValueEvent> {return this.valueEvents.list()}
    addEvent(props?: ValueEventProps): ValueEvent {return this.valueEvents.add(props)}
    addEvents(events: ReadonlyArray<ValueEventProps>): ReadonlyArray<ValueEvent> {return this.valueEvents.addAll(events)}
    clearEvents(): void {this.valueEvents.clear()}
}

export class AudioRegionImpl extends RegionFacade<AudioRegionBox> implements AudioRegion {
    static wrap(context: Context, box: AudioRegionBox): AudioRegionImpl {
        return context.facade(box, () => new AudioRegionImpl(context, box))
    }

    declare gain: float
    declare waveformOffset: seconds
    declare readonly fading: AudioFading

    private constructor(context: Context, box: AudioRegionBox) {
        super(context, box)
        this.bind({
            gain: box.gain, waveformOffset: box.waveformOffset,
            fading: {in: box.fading.in, out: box.fading.out, inSlope: box.fading.inSlope, outSlope: box.fading.outSlope}
        })
    }

    get track(): AudioTrack {return TrackImpls.wrap(this.context, this.trackBox) as AudioTrack}
    get sample(): Sample {return AudioContents.sample(this.context, this.box)}
    get playback(): AudioPlayback {return AudioContents.playback(this.box)}
    get transientPlayMode(): TransientPlayMode {return AudioContents.transientPlayMode(this.box)}
    set transientPlayMode(value: TransientPlayMode) {AudioContents.setTransientPlayMode(this.context, this.box, value)}
    get playbackRate(): float {return AudioContents.playbackRate(this.box)}
    set playbackRate(value: float) {AudioContents.setPlaybackRate(this.context, this.box, value)}
    get transpose(): float {return AudioContents.transpose(this.box)}
    set transpose(value: float) {AudioContents.setTranspose(this.context, this.box, value)}
}

export type AnyRegionImpl = NoteRegionImpl | AudioRegionImpl | ValueRegionImpl

export namespace Regions {
    export const wrap = (context: Context, box: Box): AnyRegionImpl => {
        if (box instanceof NoteRegionBox) {return NoteRegionImpl.wrap(context, box)}
        if (box instanceof AudioRegionBox) {return AudioRegionImpl.wrap(context, box)}
        if (box instanceof ValueRegionBox) {return ValueRegionImpl.wrap(context, box)}
        return panic(`${box.name} is not a region`)
    }

    export const list = (context: Context, trackBox: TrackBox): ReadonlyArray<AnyRegionImpl> =>
        trackBox.regions.pointerHub.incoming()
            .map(({box}) => wrap(context, box))
            .sort((a, b) => a.position - b.position)

    export const assertNoOverlap = (context: Context, trackBox: TrackBox, position: number, duration: number, timeBase: TimeBase): void => {
        if (timeBase === TimeBase.Seconds) {return}
        const complete = position + duration
        list(context, trackBox).forEach(region => {
            if (region instanceof AudioRegionImpl && region.box.timeBase.getValue() === TimeBase.Seconds) {return}
            if (region.position < complete && region.complete > position) {
                return panic(new RangeError(`Region [${position}, ${complete}] overlaps existing region '${region.label}' [${region.position}, ${region.complete}]`))
            }
        })
    }

    export const validateTrackType = (trackBox: TrackBox, expected: TrackType, what: string): void => {
        if (trackBox.type.getValue() !== expected) {
            return panic(new TypeError(`Cannot add ${what} to a ${TrackType.toLabelString(trackBox.type.getValue())} track`))
        }
    }

    const mirrorCollection = <C extends Box>(mirror: unknown): C => {
        if (mirror instanceof NoteRegionImpl || mirror instanceof NoteClipImpl) {
            return mirror.noteEvents.collection as unknown as C
        }
        if (mirror instanceof ValueRegionImpl || mirror instanceof ValueClipImpl) {
            return mirror.valueEvents.collection as unknown as C
        }
        return panic(new TypeError(`mirror: expected a region or clip of the same type, got ${Guard.describe(mirror)}`))
    }

    const checkMirrorType = (mirror: unknown, expected: TrackType): void => {
        const isNote = mirror instanceof NoteRegionImpl || mirror instanceof NoteClipImpl
        const isValue = mirror instanceof ValueRegionImpl || mirror instanceof ValueClipImpl
        if ((expected === TrackType.Notes && !isNote) || (expected === TrackType.Value && !isValue)) {
            return panic(new TypeError("mirror: region or clip type does not match the track"))
        }
    }

    export const createNoteRegion = (context: Context, trackBox: TrackBox, props?: NoteRegionProps): NoteRegionImpl => {
        validateTrackType(trackBox, TrackType.Notes, "a note region")
        return context.edit(() => {
            const position = Guard.int32("any", props?.position ?? 0, "position")
            const duration = Guard.int32("positive", props?.duration ?? PPQN.Bar, "duration")
            assertNoOverlap(context, trackBox, position, duration, TimeBase.Musical)
            const mirror = props?.mirror
            if (isDefined(mirror)) {checkMirrorType(mirror, TrackType.Notes)}
            const collection = isDefined(mirror)
                ? mirrorCollection<NoteEventCollectionBox>(mirror)
                : NoteEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = NoteRegionBox.create(context.boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(duration)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
            })
            const rest = Props.without(props, "mirror", "position", "duration")
            return Props.apply(NoteRegionImpl.wrap(context, box), rest)
        })
    }

    export const createValueRegion = (context: Context, trackBox: TrackBox, props?: ValueRegionProps): ValueRegionImpl => {
        validateTrackType(trackBox, TrackType.Value, "an automation region")
        return context.edit(() => {
            const position = Guard.int32("any", props?.position ?? 0, "position")
            const duration = Guard.int32("positive", props?.duration ?? PPQN.Bar, "duration")
            assertNoOverlap(context, trackBox, position, duration, TimeBase.Musical)
            const mirror = props?.mirror
            if (isDefined(mirror)) {checkMirrorType(mirror, TrackType.Value)}
            const collection = isDefined(mirror)
                ? mirrorCollection<ValueEventCollectionBox>(mirror)
                : ValueEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = ValueRegionBox.create(context.boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(duration)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Value))
                box.regions.refer(trackBox.regions)
                box.events.refer(collection.owners)
            })
            const rest = Props.without(props, "mirror", "position", "duration")
            return Props.apply(ValueRegionImpl.wrap(context, box), rest)
        })
    }

    export const createAudioRegion = (context: Context, trackBox: TrackBox, sample: Sample, props?: AudioRegionProps): AudioRegionImpl => {
        validateTrackType(trackBox, TrackType.Audio, "an audio region")
        return context.edit(() => {
            const fileBox = AudioFiles.use(context, sample)
            const validated = AudioFiles.validate(sample)
            const playback = isDefined(props?.playback) ? AudioContents.validatePlayback(props.playback) : AudioContents.defaultPlayback(validated)
            const projectBpm = context.skeleton.mandatoryBoxes.timelineBox.bpm.getValue()
            const position = Guard.int32("any", props?.position ?? 0, "position")
            const duration = Guard.float32("positive", props?.duration ?? AudioContents.defaultDuration(validated, playback, projectBpm), "duration")
            const timeBase = playback === "no-sync" ? TimeBase.Seconds : TimeBase.Musical
            assertNoOverlap(context, trackBox, position, duration, timeBase)
            const playMode = AudioContents.createPlayMode(context, playback, duration, validated.duration, {
                transientPlayMode: props?.transientPlayMode, playbackRate: props?.playbackRate, transpose: props?.transpose
            })
            const collection = ValueEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = AudioRegionBox.create(context.boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.loopDuration.setValue(duration)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                box.label.setValue(validated.name)
                box.regions.refer(trackBox.regions)
                box.file.refer(fileBox)
                box.events.refer(collection.owners)
                box.timeBase.setValue(timeBase)
                if (isDefined(playMode)) {box.playMode.refer(playMode)}
            })
            const rest = Props.without(props, "playback", "position", "duration", "transientPlayMode", "playbackRate", "transpose")
            return Props.apply(AudioRegionImpl.wrap(context, box), rest)
        })
    }

    export const forEachRegion = (context: Context, procedure: Procedure<AnyRegionImpl>): void =>
        context.boxGraph.boxes().forEach(box => {
            if (box instanceof NoteRegionBox || box instanceof AudioRegionBox || box instanceof ValueRegionBox) {
                procedure(wrap(context, box))
            }
        })
}
