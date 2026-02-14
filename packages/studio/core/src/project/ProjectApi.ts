import {
    asInstanceOf,
    assert,
    Attempt,
    Attempts,
    clamp,
    float,
    int,
    isAbsent,
    isDefined,
    isInstanceOf,
    Observer,
    Option,
    panic,
    quantizeRound,
    Strings,
    Subscription,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {BoxGraph, Field, IndexedBox, PointerField} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioClipBox,
    AudioRegionBox,
    AudioUnitBox,
    CaptureAudioBox,
    CaptureMidiBox,
    NoteClipBox,
    NoteEventBox,
    NoteEventCollectionBox,
    NoteRegionBox,
    TrackBox,
    ValueClipBox,
    ValueEventCollectionBox,
    ValueRegionBox
} from "@opendaw/studio-boxes"
import {
    AnyRegionBoxAdapter,
    AudioUnitBoxAdapter,
    AudioUnitFactory,
    CaptureBox,
    ColorCodes,
    EffectPointerType,
    IndexedAdapterCollectionListener,
    InstrumentBox,
    InstrumentFactory,
    InstrumentOptions,
    InstrumentProduct,
    ProjectQueries,
    TrackType
} from "@opendaw/studio-adapters"
import {Project} from "./Project"
import {EffectFactory} from "../EffectFactory"
import {EffectBox} from "../EffectBox"
import {AudioContentFactory} from "./audio"

export type ClipRegionOptions = {
    name?: string
    hue?: number
}

export type NoteEventParams = {
    owner: { events: PointerField<Pointers.NoteEventCollection> }
    position: ppqn
    duration: ppqn
    pitch: int
    cent?: number
    velocity?: float
    chance?: int
}

export type NoteRegionParams = {
    trackBox: TrackBox
    position: ppqn
    duration: ppqn
    loopOffset?: ppqn
    loopDuration?: ppqn
    eventOffset?: ppqn
    eventCollection?: NoteEventCollectionBox
    mute?: boolean
    name?: string
    hue?: number
}

export type QuantiseNotesOptions = {
    positionQuantisation?: ppqn
    durationQuantisation?: ppqn
}

// noinspection JSUnusedGlobalSymbols
export class ProjectApi {
    readonly #project: Project

    constructor(project: Project) {this.#project = project}

    setBpm(value: number): void {
        if (isNaN(value)) {return}
        this.#project.timelineBoxAdapter.box.bpm.setValue(clamp(value, 30, 1000))
    }

    catchupAndSubscribeBpm(observer: Observer<number>): Subscription {
        return this.#project.timelineBoxAdapter.box.bpm.catchupAndSubscribe(owner => observer(owner.getValue()))
    }

    catchupAndSubscribeAudioUnits(listener: IndexedAdapterCollectionListener<AudioUnitBoxAdapter>): Subscription {
        return this.#project.rootBoxAdapter.audioUnits.catchupAndSubscribe(listener)
    }

    createInstrument<A, INST extends InstrumentBox>(
        {create, defaultIcon, defaultName, trackType}: InstrumentFactory<A, INST>,
        options: InstrumentOptions<A> = {} as any): InstrumentProduct<INST> {
        const {name, icon, index} = options
        const {boxGraph, rootBox, userEditingManager} = this.#project
        assert(rootBox.isAttached(), "rootBox not attached")
        const existingNames = ProjectQueries.existingInstrumentNames(rootBox)
        const audioUnitBox = AudioUnitFactory.create(this.#project.skeleton,
            AudioUnitType.Instrument, this.#trackTypeToCapture(boxGraph, trackType), index)
        const uniqueName = Strings.getUniqueName(existingNames, name ?? defaultName)
        const iconSymbol = icon ?? defaultIcon
        const instrumentBox = create(boxGraph, audioUnitBox.input, uniqueName, iconSymbol, options.attachment)
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(0)
            box.type.setValue(trackType)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
        })
        userEditingManager.audioUnit.edit(audioUnitBox.editing)
        return {audioUnitBox, instrumentBox, trackBox}
    }

    createAnyInstrument(factory: InstrumentFactory<any, any>): InstrumentProduct<InstrumentBox> {
        return this.createInstrument(factory)
    }

    replaceMIDIInstrument<A>(target: InstrumentBox,
                             fromFactory: InstrumentFactory<A>,
                             attachment?: A): Attempt<InstrumentBox, string> {
        const replacedInstrumentName = target.label.getValue()
        const hostBox = target.host.targetVertex.unwrap("Is not connect to AudioUnitBox").box
        const audioUnitBox = asInstanceOf(hostBox, AudioUnitBox)
        if (audioUnitBox.type.getValue() !== AudioUnitType.Instrument) {
            return Attempts.err("AudioUnitBox does not hold an instrument")
        }
        const captureBox = audioUnitBox.capture.targetVertex.unwrap("AudioUnitBox does not hold a capture").box
        if (!isInstanceOf(captureBox, CaptureMidiBox)) {
            return Attempts.err("Cannot replace instrument without CaptureMidiBox")
        }
        if (fromFactory.trackType !== TrackType.Notes) {
            return Attempts.err("Cannot replace instrument with track type " + TrackType[fromFactory.trackType] + "")
        }
        console.debug(`Replace instrument '${replacedInstrumentName}' with ${fromFactory.defaultName}`)
        target.delete()
        const {boxGraph} = this.#project
        const {create, defaultIcon, defaultName}: InstrumentFactory = fromFactory
        return Attempts.ok(create(boxGraph, audioUnitBox.input, defaultName, defaultIcon, attachment))
    }

    insertEffect(field: Field<EffectPointerType>, factory: EffectFactory, insertIndex: int = Number.MAX_SAFE_INTEGER): EffectBox {
        return factory.create(this.#project, field, IndexedBox.insertOrder(field, insertIndex))
    }

    createNoteTrack(audioUnitBox: AudioUnitBox, insertIndex: int = Number.MAX_SAFE_INTEGER): TrackBox {
        return this.#createTrack({field: audioUnitBox.tracks, trackType: TrackType.Notes, insertIndex})
    }

    createAudioTrack(audioUnitBox: AudioUnitBox, insertIndex: int = Number.MAX_SAFE_INTEGER): TrackBox {
        return this.#createTrack({field: audioUnitBox.tracks, trackType: TrackType.Audio, insertIndex})
    }

    createAutomationTrack(audioUnitBox: AudioUnitBox, target: Field<Pointers.Automation>, insertIndex: int = Number.MAX_SAFE_INTEGER): TrackBox {
        return this.#createTrack({field: audioUnitBox.tracks, target, trackType: TrackType.Value, insertIndex})
    }

    createTimeStretchedClip(props: AudioContentFactory.TimeStretchedProps & AudioContentFactory.Clip): AudioClipBox {
        return AudioContentFactory.createTimeStretchedClip(props)
    }

    createTimeStretchedRegion(props: AudioContentFactory.TimeStretchedProps & AudioContentFactory.Region): AudioRegionBox {
        return AudioContentFactory.createTimeStretchedRegion(props)
    }

    createPitchStretchedClip(props: AudioContentFactory.PitchStretchedProps & AudioContentFactory.Clip): AudioClipBox {
        return AudioContentFactory.createPitchStretchedClip(props)
    }

    createPitchStretchedRegion(props: AudioContentFactory.PitchStretchedProps & AudioContentFactory.Region): AudioRegionBox {
        return AudioContentFactory.createPitchStretchedRegion(props)
    }

    createNotStretchedClip(props: AudioContentFactory.NotStretchedProps & AudioContentFactory.Clip): AudioClipBox {
        return AudioContentFactory.createNotStretchedClip(props)
    }

    createNotStretchedRegion(props: AudioContentFactory.NotStretchedProps & AudioContentFactory.Region): AudioRegionBox {
        return AudioContentFactory.createNotStretchedRegion(props)
    }

    createNoteClip(trackBox: TrackBox, clipIndex: int, {name, hue}: ClipRegionOptions = {}): NoteClipBox {
        const {boxGraph} = this.#project
        const type = trackBox.type.getValue()
        if (type !== TrackType.Notes) {return panic("Incompatible track type for note-clip creation: " + type.toString())}
        const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteClipBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(clipIndex)
            box.label.setValue(name ?? "Notes")
            box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
            box.mute.setValue(false)
            box.duration.setValue(PPQN.Bar)
            box.clips.refer(trackBox.clips)
            box.events.refer(events.owners)
        })
    }

    duplicateRegion<R extends AnyRegionBoxAdapter>(region: R, options?: { findFreeSpace?: boolean }): Option<R> {
        if (region.trackBoxAdapter.isEmpty()) {return Option.None}
        const track = region.trackBoxAdapter.unwrap()
        if (options?.findFreeSpace === true) {
            let insert = region.complete
            for (const {position, complete} of track.regions.collection.iterateFrom(region.complete)) {
                if (insert + region.duration <= position) {break}
                insert = complete
            }
            return Option.wrap(region.copyTo({
                position: insert,
                consolidate: true
            }) as R)
        } else {
            const clearFrom = region.complete
            const clearTo = region.complete + region.duration
            const targetTrack = this.#project.overlapResolver.resolveTargetTrack(track, clearFrom, clearTo)
            const solver = this.#project.overlapResolver.fromRange(targetTrack, clearFrom, clearTo)
            const duplicate = region.copyTo({
                position: region.complete,
                consolidate: true
            }) as R
            solver()
            return Option.wrap(duplicate)
        }
    }

    quantiseNotes(collection: NoteEventCollectionBox,
                  {positionQuantisation, durationQuantisation}: QuantiseNotesOptions): void {
        if (isAbsent(positionQuantisation) && isAbsent(durationQuantisation)) {
            console.warn("Nothing to quantise: both quantisation parameters are absent")
            return
        }
        collection.events.pointerHub.incoming().forEach(({box}) => {
            const event = asInstanceOf(box, NoteEventBox)
            let position = event.position.getValue()
            let duration = event.duration.getValue()
            if (isDefined(positionQuantisation)) {
                position = quantizeRound(position, positionQuantisation)
            }
            if (isDefined(durationQuantisation)) {
                duration = Math.max(quantizeRound(duration, durationQuantisation), durationQuantisation)
            }
            event.position.setValue(Math.max(position, 0))
            event.duration.setValue(duration)
        })
    }

    createValueClip(trackBox: TrackBox, clipIndex: int, {name, hue}: ClipRegionOptions = {}): ValueClipBox {
        const {boxGraph} = this.#project
        const type = trackBox.type.getValue()
        if (type !== TrackType.Value) {return panic("Incompatible track type for value-clip creation: " + type.toString())}
        const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return ValueClipBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(clipIndex)
            box.label.setValue(name ?? "Automation")
            box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
            box.mute.setValue(false)
            box.duration.setValue(PPQN.Bar)
            box.events.refer(events.owners)
            box.clips.refer(trackBox.clips)
        })
    }

    createNoteRegion({
                         trackBox, position, duration, loopOffset, loopDuration,
                         eventOffset, eventCollection, mute, name, hue
                     }: NoteRegionParams): NoteRegionBox {
        if (trackBox.type.getValue() !== TrackType.Notes) {
            console.warn("You should not create a note-region in mismatched track")
        }
        const {boxGraph} = this.#project
        const events = eventCollection ?? NoteEventCollectionBox.create(boxGraph, UUID.generate())
        return NoteRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.label.setValue(name ?? "Notes")
            box.hue.setValue(hue ?? ColorCodes.forTrackType(trackBox.type.getValue()))
            box.mute.setValue(mute ?? false)
            box.duration.setValue(duration)
            box.loopDuration.setValue(loopOffset ?? 0)
            box.loopDuration.setValue(loopDuration ?? duration)
            box.eventOffset.setValue(eventOffset ?? 0)
            box.events.refer(events.owners)
            box.regions.refer(trackBox.regions)
        })
    }

    createTrackRegion(trackBox: TrackBox, position: ppqn, duration: ppqn, {name, hue}: ClipRegionOptions = {}) {
        const {boxGraph} = this.#project
        const type = trackBox.type.getValue()
        switch (type) {
            case TrackType.Notes: {
                const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                return Option.wrap(NoteRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(Math.max(position, 0))
                    box.label.setValue(name ?? "Notes")
                    box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
                    box.mute.setValue(false)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(duration)
                    box.events.refer(events.owners)
                    box.regions.refer(trackBox.regions)
                }))
            }
            case TrackType.Value: {
                const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                return Option.wrap(ValueRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(Math.max(position, 0))
                    box.label.setValue(name ?? "Automation")
                    box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
                    box.mute.setValue(false)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(duration)
                    box.events.refer(events.owners)
                    box.regions.refer(trackBox.regions)
                }))
            }
        }
        return Option.None
    }

    createNoteEvent({owner, position, duration, velocity, pitch, chance, cent}: NoteEventParams): NoteEventBox {
        const {boxGraph} = this.#project
        return NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(duration)
            box.velocity.setValue(velocity ?? 1.0)
            box.pitch.setValue(pitch)
            box.chance.setValue(chance ?? 100.0)
            box.cent.setValue(cent ?? 0.0)
            box.events.refer(owner.events.targetVertex
                .unwrap("Owner has no event-collection").box
                .asBox(NoteEventCollectionBox).events)
        })
    }

    deleteAudioUnit(audioUnitBox: AudioUnitBox): void {
        const {rootBox} = this.#project
        IndexedBox.removeOrder(rootBox.audioUnits, audioUnitBox.index.getValue())
        audioUnitBox.delete()
    }

    #createTrack({field, target, trackType, insertIndex}: {
        field: Field<Pointers.TrackCollection>,
        target?: Field<Pointers.Automation>,
        insertIndex: int
        trackType: TrackType,
    }): TrackBox {
        const index = IndexedBox.insertOrder(field, insertIndex)
        return TrackBox.create(this.#project.boxGraph, UUID.generate(), box => {
            box.index.setValue(index)
            box.type.setValue(trackType)
            box.tracks.refer(field)
            box.target.refer(target ?? field.box)
        })
    }

    #trackTypeToCapture(boxGraph: BoxGraph, trackType: TrackType): Option<CaptureBox> {
        switch (trackType) {
            case TrackType.Audio:
                return Option.wrap(CaptureAudioBox.create(boxGraph, UUID.generate()))
            case TrackType.Notes:
                return Option.wrap(CaptureMidiBox.create(boxGraph, UUID.generate()))
            default:
                return Option.None
        }
    }
}