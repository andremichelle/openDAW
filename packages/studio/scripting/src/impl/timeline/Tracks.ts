import {AudioUnitBox, TrackBox} from "@opendaw/studio-boxes"
import {Box, Field, IndexedBox, PrimitiveField, Vertex} from "@opendaw/lib-box"
import {TrackType} from "@opendaw/studio-adapters"
import {asInstanceOf, int, isDefined, isNull, Nullable, panic} from "@opendaw/lib-std"
import {UUID} from "@opendaw/lib-std"
import {
    AnyAudioUnit,
    AnyModulator,
    AudioClip,
    AudioClipProps,
    AudioRegion,
    AudioRegionProps,
    AudioTrack,
    Automatable,
    NoteClip,
    NoteClipProps,
    NoteRegion,
    NoteRegionProps,
    NoteTrack,
    Sample,
    ValueClip,
    ValueClipProps,
    ValueRegion,
    ValueRegionProps,
    ValueTrack
} from "../../Api"
import {Context} from "../Context"
import {Facade, Parameters} from "../Common"
import {Facades} from "../Facades"
import {AudioRegionImpl, NoteRegionImpl, Regions, ValueRegionImpl} from "./Regions"
import {AudioClipImpl, Clips, NoteClipImpl, ValueClipImpl} from "./Clips"
import {ModulatorImpls} from "../Modulators"

export abstract class TrackFacade extends Facade<TrackBox> {
    abstract readonly type: "notes" | "audio" | "value"
    declare enabled: boolean
    declare excludePianoMode: boolean

    protected constructor(context: Context, box: TrackBox) {
        super(context, box)
        this.bind({enabled: box.enabled, excludePianoMode: box.excludePianoMode})
    }

    get index(): int {return this.box.index.getValue()}

    get ownerBox(): Box {return this.box.tracks.targetVertex.unwrap("track has no owner").box}

    get owner(): AnyAudioUnit | AnyModulator {
        const ownerBox = this.ownerBox
        if (ownerBox instanceof AudioUnitBox) {return Facades.audioUnitOf(this.context, ownerBox)}
        return ModulatorImpls.wrap(this.context, ownerBox)
    }

    get audioUnit(): Nullable<AnyAudioUnit> {
        const ownerBox = this.ownerBox
        return ownerBox instanceof AudioUnitBox ? Facades.audioUnitOf(this.context, ownerBox) : null
    }

    remove(): void {
        this.context.edit(() => {
            const field = this.box.tracks.targetVertex.unwrap("track has no owner") as Field
            const index = this.index
            IndexedBox.removeOrder(field, index)
            this.box.delete()
        })
    }
}

export class NoteTrackImpl extends TrackFacade implements NoteTrack {
    readonly type = "notes" as const

    constructor(context: Context, box: TrackBox) {super(context, box)}

    get regions(): ReadonlyArray<NoteRegion> {
        return Regions.list(this.context, this.box).filter((region): region is NoteRegionImpl => region instanceof NoteRegionImpl)
    }
    get clips(): ReadonlyArray<NoteClip> {
        return Clips.list(this.context, this.box).filter((clip): clip is NoteClipImpl => clip instanceof NoteClipImpl)
    }
    addRegion(props?: NoteRegionProps): NoteRegion {return Regions.createNoteRegion(this.context, this.box, props)}
    addClip(props?: NoteClipProps): NoteClip {return Clips.createNoteClip(this.context, this.box, props)}
}

export class AudioTrackImpl extends TrackFacade implements AudioTrack {
    readonly type = "audio" as const

    constructor(context: Context, box: TrackBox) {super(context, box)}

    get regions(): ReadonlyArray<AudioRegion> {
        return Regions.list(this.context, this.box).filter((region): region is AudioRegionImpl => region instanceof AudioRegionImpl)
    }
    get clips(): ReadonlyArray<AudioClip> {
        return Clips.list(this.context, this.box).filter((clip): clip is AudioClipImpl => clip instanceof AudioClipImpl)
    }
    addRegion(sample: Sample, props?: AudioRegionProps): AudioRegion {
        return Regions.createAudioRegion(this.context, this.box, sample, props)
    }
    addClip(sample: Sample, props?: AudioClipProps): AudioClip {
        return Clips.createAudioClip(this.context, this.box, sample, props)
    }
}

export class ValueTrackImpl extends TrackFacade implements ValueTrack {
    readonly type = "value" as const

    constructor(context: Context, box: TrackBox) {super(context, box)}

    get targetField(): PrimitiveField {
        const vertex = this.box.target.targetVertex.unwrap("automation track has no target")
        if (!(vertex instanceof PrimitiveField)) {return panic("automation target is not a parameter")}
        return vertex
    }
    get target(): Automatable {
        const facade = Facades.forBox(this.context, this.targetField.box)
        if (isNull(facade)) {return panic(`No object found for automation target ${this.targetField.toString()}`)}
        return facade as Automatable
    }
    get parameter(): string {
        return Parameters.pathOf(this.target, this.targetField) ?? panic(`Unknown parameter path for ${this.targetField.toString()}`)
    }
    get regions(): ReadonlyArray<ValueRegion> {
        return Regions.list(this.context, this.box).filter((region): region is ValueRegionImpl => region instanceof ValueRegionImpl)
    }
    get clips(): ReadonlyArray<ValueClip> {
        return Clips.list(this.context, this.box).filter((clip): clip is ValueClipImpl => clip instanceof ValueClipImpl)
    }
    addRegion(props?: ValueRegionProps): ValueRegion {return Regions.createValueRegion(this.context, this.box, props)}
    addClip(props?: ValueClipProps): ValueClip {return Clips.createValueClip(this.context, this.box, props)}
}

export type AnyTrackImpl = NoteTrackImpl | AudioTrackImpl | ValueTrackImpl

export namespace TrackImpls {
    export const wrap = (context: Context, box: TrackBox): AnyTrackImpl => context.facade(box, () => {
        switch (box.type.getValue()) {
            case TrackType.Notes: return new NoteTrackImpl(context, box)
            case TrackType.Audio: return new AudioTrackImpl(context, box)
            case TrackType.Value: return new ValueTrackImpl(context, box)
            default: return panic(`Unsupported track type ${box.type.getValue()}`)
        }
    }) as AnyTrackImpl

    export const list = (context: Context, field: Field): ReadonlyArray<AnyTrackImpl> =>
        IndexedBox.collectIndexedBoxes(field, TrackBox)
            .filter(box => box.type.getValue() !== TrackType.Undefined)
            .map(box => wrap(context, box))

    export const reindex = (field: Field): void =>
        IndexedBox.collectIndexedBoxes(field, TrackBox).forEach((box, index) => box.index.setValue(index))

    export const create = (context: Context, field: Field, type: TrackType, target: Vertex, insertIndex: Nullable<int> | undefined): AnyTrackImpl =>
        context.edit(() => {
            const index = IndexedBox.insertOrder(field, isDefined(insertIndex) ? Math.round(insertIndex) : Number.MAX_SAFE_INTEGER)
            const box = TrackBox.create(context.boxGraph, UUID.generate(), box => {
                box.index.setValue(index)
                box.type.setValue(type)
                box.tracks.refer(field)
                box.target.refer(target)
            })
            return wrap(context, box)
        })
}
