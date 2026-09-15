import {
    AudioClipBox,
    NoteClipBox,
    NoteEventCollectionBox,
    TrackBox,
    ValueClipBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {PPQN, seconds, TimeBase} from "@opendaw/lib-dsp"
import {ColorCodes, TrackType} from "@opendaw/studio-adapters"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {asInstanceOf, float, int, isDefined, panic, UUID} from "@opendaw/lib-std"
import {
    AudioClip,
    AudioClipProps,
    AudioPlayback,
    AudioTrack,
    ClipPlayback,
    NoteClip,
    NoteClipProps,
    NoteEvent,
    NoteEventProps,
    NoteTrack,
    Sample,
    ValueClip,
    ValueClipProps,
    ValueEvent,
    ValueEventProps,
    ValueTrack
} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Guard} from "../Guard"
import {NoteEvents, ValueEvents} from "./Events"
import {AudioContents} from "./AudioContents"
import {AudioFiles} from "../AudioFiles"
import {TrackImpls} from "./Tracks"
import {NoteRegionImpl, ValueRegionImpl} from "./Regions"

export type ClipBox = NoteClipBox | AudioClipBox | ValueClipBox

export abstract class ClipFacade<B extends ClipBox> extends Facade<B> {
    declare duration: number
    declare mute: boolean
    declare label: string
    declare hue: int
    declare readonly launch: ClipPlayback

    protected constructor(context: Context, box: B) {
        super(context, box)
        const {triggerMode} = box
        this.bind({
            duration: box.duration, mute: box.mute, label: box.label, hue: box.hue,
            launch: {
                loop: triggerMode.loop, reverse: triggerMode.reverse, speed: triggerMode.speed,
                quantise: triggerMode.quantise, trigger: triggerMode.trigger
            }
        })
    }

    get index(): int {return this.box.index.getValue()}
    set index(value: int) {
        const index = Guard.int32("index", value, "index")
        const taken = Clips.list(this.context, this.trackBox).some(clip => clip.box !== this.box && clip.index === index)
        if (taken) {panic(new RangeError(`index: slot ${index} is already taken`))}
        this.context.edit(() => this.box.index.setValue(index))
    }

    get trackBox(): TrackBox {
        return asInstanceOf(this.box.clips.targetVertex.unwrap("clip has no track").box, TrackBox)
    }
}

export class NoteClipImpl extends ClipFacade<NoteClipBox> implements NoteClip {
    static wrap(context: Context, box: NoteClipBox): NoteClipImpl {
        return context.facade(box, () => new NoteClipImpl(context, box))
    }

    private constructor(context: Context, box: NoteClipBox) {super(context, box)}

    get track(): NoteTrack {return TrackImpls.wrap(this.context, this.trackBox) as NoteTrack}
    get noteEvents(): NoteEvents {
        return new NoteEvents(this.context, asInstanceOf(this.box.events.targetVertex.unwrap("clip has no events").box, NoteEventCollectionBox))
    }
    get events(): ReadonlyArray<NoteEvent> {return this.noteEvents.list()}
    addEvent(props?: NoteEventProps): NoteEvent {return this.noteEvents.add(props)}
    addEvents(events: ReadonlyArray<NoteEventProps>): ReadonlyArray<NoteEvent> {return this.noteEvents.addAll(events)}
    clearEvents(): void {this.noteEvents.clear()}
}

export class ValueClipImpl extends ClipFacade<ValueClipBox> implements ValueClip {
    static wrap(context: Context, box: ValueClipBox): ValueClipImpl {
        return context.facade(box, () => new ValueClipImpl(context, box))
    }

    private constructor(context: Context, box: ValueClipBox) {super(context, box)}

    get track(): ValueTrack {return TrackImpls.wrap(this.context, this.trackBox) as ValueTrack}
    get valueEvents(): ValueEvents {
        return new ValueEvents(this.context, asInstanceOf(this.box.events.targetVertex.unwrap("clip has no events").box, ValueEventCollectionBox))
    }
    get events(): ReadonlyArray<ValueEvent> {return this.valueEvents.list()}
    addEvent(props?: ValueEventProps): ValueEvent {return this.valueEvents.add(props)}
    addEvents(events: ReadonlyArray<ValueEventProps>): ReadonlyArray<ValueEvent> {return this.valueEvents.addAll(events)}
    clearEvents(): void {this.valueEvents.clear()}
}

export class AudioClipImpl extends ClipFacade<AudioClipBox> implements AudioClip {
    static wrap(context: Context, box: AudioClipBox): AudioClipImpl {
        return context.facade(box, () => new AudioClipImpl(context, box))
    }

    declare gain: float
    declare waveformOffset: seconds

    private constructor(context: Context, box: AudioClipBox) {
        super(context, box)
        this.bind({gain: box.gain, waveformOffset: box.waveformOffset})
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

export type AnyClipImpl = NoteClipImpl | AudioClipImpl | ValueClipImpl

export namespace Clips {
    export const wrap = (context: Context, box: Box): AnyClipImpl => {
        if (box instanceof NoteClipBox) {return NoteClipImpl.wrap(context, box)}
        if (box instanceof AudioClipBox) {return AudioClipImpl.wrap(context, box)}
        if (box instanceof ValueClipBox) {return ValueClipImpl.wrap(context, box)}
        return panic(`${box.name} is not a clip`)
    }

    export const list = (context: Context, trackBox: TrackBox): ReadonlyArray<AnyClipImpl> =>
        trackBox.clips.pointerHub.incoming()
            .map(({box}) => wrap(context, box))
            .sort((a, b) => a.index - b.index)

    export const resolveIndex = (context: Context, trackBox: TrackBox, index: unknown): int => {
        const taken = new Set(list(context, trackBox).map(clip => clip.index))
        if (isDefined(index)) {
            const validated = Guard.int32("index", index, "index")
            if (taken.has(validated)) {return panic(new RangeError(`index: slot ${validated} is already taken`))}
            return validated
        }
        let free = 0
        while (taken.has(free)) {free++}
        return free
    }

    const mirrorCollection = <C extends Box>(mirror: unknown, expected: TrackType): C => {
        if (expected === TrackType.Notes && (mirror instanceof NoteRegionImpl || mirror instanceof NoteClipImpl)) {
            return mirror.noteEvents.collection as unknown as C
        }
        if (expected === TrackType.Value && (mirror instanceof ValueRegionImpl || mirror instanceof ValueClipImpl)) {
            return mirror.valueEvents.collection as unknown as C
        }
        return panic(new TypeError(`mirror: expected a region or clip of the same type, got ${Guard.describe(mirror)}`))
    }

    export const createNoteClip = (context: Context, trackBox: TrackBox, props?: NoteClipProps): NoteClipImpl => {
        if (trackBox.type.getValue() !== TrackType.Notes) {return panic(new TypeError("Cannot add a note clip to a non-note track"))}
        return context.edit(() => {
            const index = resolveIndex(context, trackBox, props?.index)
            const collection = isDefined(props?.mirror)
                ? mirrorCollection<NoteEventCollectionBox>(props.mirror, TrackType.Notes)
                : NoteEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = NoteClipBox.create(context.boxGraph, UUID.generate(), box => {
                box.index.setValue(index)
                box.duration.setValue(PPQN.Bar)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Notes))
                box.clips.refer(trackBox.clips)
                box.events.refer(collection.owners)
            })
            const clip = Props.apply(NoteClipImpl.wrap(context, box), Props.without(props, "mirror", "index", "launch"))
            if (isDefined(props?.launch)) {Props.apply(clip.launch, props.launch, "launch")}
            return clip
        })
    }

    export const createValueClip = (context: Context, trackBox: TrackBox, props?: ValueClipProps): ValueClipImpl => {
        if (trackBox.type.getValue() !== TrackType.Value) {return panic(new TypeError("Cannot add an automation clip to a non-automation track"))}
        return context.edit(() => {
            const index = resolveIndex(context, trackBox, props?.index)
            const collection = isDefined(props?.mirror)
                ? mirrorCollection<ValueEventCollectionBox>(props.mirror, TrackType.Value)
                : ValueEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = ValueClipBox.create(context.boxGraph, UUID.generate(), box => {
                box.index.setValue(index)
                box.duration.setValue(PPQN.Bar)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Value))
                box.clips.refer(trackBox.clips)
                box.events.refer(collection.owners)
            })
            const clip = Props.apply(ValueClipImpl.wrap(context, box), Props.without(props, "mirror", "index", "launch"))
            if (isDefined(props?.launch)) {Props.apply(clip.launch, props.launch, "launch")}
            return clip
        })
    }

    export const createAudioClip = (context: Context, trackBox: TrackBox, sample: Sample, props?: AudioClipProps): AudioClipImpl => {
        if (trackBox.type.getValue() !== TrackType.Audio) {return panic(new TypeError("Cannot add an audio clip to a non-audio track"))}
        return context.edit(() => {
            const fileBox = AudioFiles.use(context, sample)
            const validated = AudioFiles.validate(sample)
            const playback = isDefined(props?.playback) ? AudioContents.validatePlayback(props.playback) : AudioContents.defaultPlayback(validated)
            const projectBpm = context.skeleton.mandatoryBoxes.timelineBox.bpm.getValue()
            const index = resolveIndex(context, trackBox, props?.index)
            const duration = Guard.float32("positive", props?.duration ?? AudioContents.defaultDuration(validated, playback, projectBpm), "duration")
            const timeBase = playback === "no-sync" ? TimeBase.Seconds : TimeBase.Musical
            const playMode = AudioContents.createPlayMode(context, playback, duration, validated.duration, {
                transientPlayMode: props?.transientPlayMode, playbackRate: props?.playbackRate, transpose: props?.transpose
            })
            const collection = ValueEventCollectionBox.create(context.boxGraph, UUID.generate())
            const box = AudioClipBox.create(context.boxGraph, UUID.generate(), box => {
                box.index.setValue(index)
                box.duration.setValue(duration)
                box.hue.setValue(ColorCodes.forTrackType(TrackType.Audio))
                box.label.setValue(validated.name)
                box.clips.refer(trackBox.clips)
                box.file.refer(fileBox)
                box.events.refer(collection.owners)
                box.timeBase.setValue(timeBase)
                if (isDefined(playMode)) {box.playMode.refer(playMode)}
            })
            const rest = Props.without(props, "playback", "index", "duration", "transientPlayMode", "playbackRate", "transpose", "launch")
            const clip = Props.apply(AudioClipImpl.wrap(context, box), rest)
            if (isDefined(props?.launch)) {Props.apply(clip.launch, props.launch, "launch")}
            return clip
        })
    }
}
