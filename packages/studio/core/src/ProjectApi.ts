import {
    asDefined,
    asInstanceOf,
    assert,
    clamp,
    float,
    int,
    Observer,
    Option,
    Strings,
    Subscription,
    UUID
} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {Field, IndexedBox, PointerField, StringField} from "@opendaw/lib-box"
import {AudioUnitType, Pointers} from "@opendaw/studio-enums"
import {
    AudioBusBox,
    AudioUnitBox,
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
    AnyClipBox,
    AudioUnitBoxAdapter,
    EffectPointerType,
    IconSymbol,
    IndexedAdapterCollectionListener,
    TrackType
} from "@opendaw/studio-adapters"
import {Project} from "./Project"
import {InstrumentFactory} from "./InstrumentFactory"
import {InstrumentProduct} from "./InstrumentProduct"
import {InstrumentOptions} from "./InstrumentOptions"
import {EffectFactory} from "./EffectFactory"
import {ColorCodes} from "./ColorCodes"
import {EffectBox} from "./EffectBox"

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

// noinspection JSUnusedGlobalSymbols
export class ProjectApi {
    static readonly AudioUnitOrdering: Record<string, int> = {
        [AudioUnitType.Instrument]: 0,
        [AudioUnitType.Aux]: 1,
        [AudioUnitType.Bus]: 2,
        [AudioUnitType.Output]: 3
    } as const

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

    createInstrument({create, defaultIcon, defaultName, trackType}: InstrumentFactory,
                     {name, icon, index}: InstrumentOptions = {}): InstrumentProduct {
        const {boxGraph, rootBox, userEditingManager} = this.#project
        assert(rootBox.isAttached(), "rootBox not attached")
        const existingNames = rootBox.audioUnits.pointerHub.incoming().map(({box}) => {
            const inputBox = asDefined(asInstanceOf(box, AudioUnitBox).input.pointerHub.incoming().at(0)).box
            return "label" in inputBox && inputBox.label instanceof StringField ? inputBox.label.getValue() : "N/A"
        })
        const audioUnitBox = this.#createAudioUnit(AudioUnitType.Instrument, index)
        const uniqueName = Strings.getUniqueName(existingNames, name ?? defaultName)
        const iconSymbol = icon ?? defaultIcon
        const instrumentBox = create(boxGraph, audioUnitBox.input, uniqueName, iconSymbol)
        const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.index.setValue(0)
            box.type.setValue(trackType)
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
        })
        userEditingManager.audioUnit.edit(audioUnitBox.editing)
        return {audioUnitBox, instrumentBox, trackBox}
    }

    createAudioBus(name: string,
                   icon: IconSymbol,
                   type: AudioUnitType,
                   color: string): AudioBusBox {
        console.debug(`createAudioBus '${name}', type: ${type}, color: ${color}`)
        const {rootBox, boxGraph} = this.#project
        assert(rootBox.isAttached(), "rootBox not attached")
        const uuid = UUID.generate()
        const audioBusBox = AudioBusBox.create(boxGraph, uuid, box => {
            box.collection.refer(rootBox.audioBusses)
            box.label.setValue(name)
            box.icon.setValue(IconSymbol.toName(icon))
            box.color.setValue(color)
        })
        const audioUnitBox = this.#createAudioUnit(type)
        TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(audioUnitBox.tracks)
            box.target.refer(audioUnitBox)
            box.index.setValue(0)
            box.type.setValue(TrackType.Undefined)
        })
        audioBusBox.output.refer(audioUnitBox.input)
        return audioBusBox
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

    createClip(trackBox: TrackBox, clipIndex: int, {name, hue}: ClipRegionOptions = {}): Option<AnyClipBox> {
        const {boxGraph} = this.#project
        const type = trackBox.type.getValue()
        switch (type) {
            case TrackType.Notes: {
                const events = NoteEventCollectionBox.create(boxGraph, UUID.generate())
                return Option.wrap(NoteClipBox.create(boxGraph, UUID.generate(), box => {
                    box.index.setValue(clipIndex)
                    box.label.setValue(name ?? "Notes")
                    box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
                    box.mute.setValue(false)
                    box.duration.setValue(PPQN.Bar)
                    box.clips.refer(trackBox.clips)
                    box.events.refer(events.owners)
                }))
            }
            case TrackType.Value: {
                const events = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                return Option.wrap(ValueClipBox.create(boxGraph, UUID.generate(), box => {
                    box.index.setValue(clipIndex)
                    box.label.setValue(name ?? "Automation")
                    box.hue.setValue(hue ?? ColorCodes.forTrackType(type))
                    box.mute.setValue(false)
                    box.duration.setValue(PPQN.Bar)
                    box.events.refer(events.owners)
                    box.clips.refer(trackBox.clips)
                }))
            }
        }
        return Option.None
    }

    createNoteRegion({
                         trackBox,
                         position, duration,
                         loopOffset, loopDuration,
                         eventOffset, eventCollection,
                         mute, name, hue
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
                    box.loopDuration.setValue(PPQN.Bar)
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
                    box.loopDuration.setValue(PPQN.Bar)
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

    #createAudioUnit(type: AudioUnitType, index?: int): AudioUnitBox {
        const {boxGraph, rootBox, masterBusBox} = this.#project
        const insertIndex = index ?? this.#sortAudioUnitOrdering(type)
        console.debug(`createAudioUnit type: ${type}, insertIndex: ${insertIndex}`)
        return AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(rootBox.audioUnits)
            box.output.refer(masterBusBox.input)
            box.index.setValue(insertIndex)
            box.type.setValue(type)
        })
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

    #sortAudioUnitOrdering(type: AudioUnitType): int {
        const {AudioUnitOrdering} = ProjectApi
        const {rootBox} = this.#project
        const boxes = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
        const order: int = AudioUnitOrdering[type]
        let index = 0 | 0
        for (; index < boxes.length; index++) {
            if (AudioUnitOrdering[boxes[index].type.getValue()] > order) {break}
        }
        const insertIndex = index
        while (index < boxes.length) {
            boxes[index].index.setValue(++index)
        }
        return insertIndex
    }
}