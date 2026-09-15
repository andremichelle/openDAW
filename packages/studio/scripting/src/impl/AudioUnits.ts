import {AudioBusBox, AudioUnitBox, AuxSendBox, TrackBox} from "@opendaw/studio-boxes"
import {Box, Field, IndexedBox} from "@opendaw/lib-box"
import {AudioSendRouting, AudioUnitType, IconSymbol, Pointers} from "@opendaw/studio-enums"
import {AudioUnitFactory, InstrumentFactories, ProjectQueries, TrackType} from "@opendaw/studio-adapters"
import {asInstanceOf, bipolar, float, int, isDefined, isNull, Nullable, Option, Optional, panic, Strings, UUID} from "@opendaw/lib-std"
import {
    AnyAudioEffect,
    AnyAudioUnit,
    AnyMIDIEffect,
    AnyTrack,
    AudioEffects,
    AudioTrack,
    AudioUnit,
    AudioUnitKind,
    Automatable,
    AuxAudioUnit,
    DeepPartial,
    GroupAudioUnit,
    InstrumentAudioUnit,
    Instruments,
    MIDIEffects,
    NoteTrack,
    OutputAudioUnit,
    ParameterPath,
    Send,
    Track,
    ValueTrack
} from "../Api"
import {Context} from "./Context"
import {Facade, Parameters, Props} from "./Common"
import {AnyPrimitiveField} from "./Fields"
import {Guard} from "./Guard"
import {EffectChain} from "./devices/EffectChain"
import {DeviceBoxes} from "./devices/DeviceBoxes"
import {AnyMIDIEffectImpl, MIDIEffectImpls} from "./devices/MIDIEffects"
import {AnyAudioEffectImpl, AudioEffectImpls} from "./devices/AudioEffects"
import {AnyInstrumentImpl, InstrumentImpls} from "./devices/Instruments"
import {SendImpl, Sends} from "./Sends"
import {AudioTrackImpl, NoteTrackImpl, TrackImpls, ValueTrackImpl} from "./timeline/Tracks"

export abstract class AudioUnitFacade extends Facade<AudioUnitBox> implements AudioUnit {
    abstract readonly kind: AudioUnitKind
    declare volume: float
    declare panning: bipolar
    declare mute: boolean
    declare solo: boolean
    readonly #midiChain: EffectChain<AnyMIDIEffectImpl>
    readonly #audioChain: EffectChain<AnyAudioEffectImpl>

    protected constructor(context: Context, box: AudioUnitBox) {
        super(context, box)
        this.bind({volume: box.volume, panning: box.panning, mute: box.mute, solo: box.solo})
        this.#midiChain = new EffectChain<AnyMIDIEffectImpl>(context, box.midiEffects, box => MIDIEffectImpls.wrap(context, box))
        this.#audioChain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    abstract get label(): string
    abstract set label(value: string)

    get index(): int {return this.box.index.getValue()}

    get output(): Nullable<OutputAudioUnit | GroupAudioUnit | AuxAudioUnit> {
        return this.box.output.targetVertex.mapOr(vertex => {
            const busBox = asInstanceOf(vertex.box, AudioBusBox)
            const unitField = busBox.output.targetVertex.unwrap("bus has no audio unit")
            return AudioUnitImpls.wrap(this.context, asInstanceOf(unitField.box, AudioUnitBox)) as OutputAudioUnit | GroupAudioUnit | AuxAudioUnit
        }, null)
    }
    set output(target: Nullable<OutputAudioUnit | GroupAudioUnit | AuxAudioUnit>) {
        this.context.edit(() => {
            if (isNull(target)) {
                this.box.output.defer()
                return
            }
            if (!(target instanceof AudioUnitFacade) || target.box.type.getValue() === AudioUnitType.Instrument) {
                return panic(new TypeError("output must be the output unit, a group or an auxiliary unit"))
            }
            if (target.box === this.box) {return panic(new RangeError("A unit cannot output to itself"))}
            this.box.output.refer(target.busBox.input)
        })
    }

    get busBox(): AudioBusBox {
        return this.optBusBox ?? panic(`${this.constructor.name} has no audio bus`)
    }

    get optBusBox(): Nullable<AudioBusBox> {
        return this.box.input.pointerHub.incoming().map(({box}) => box).find(box => box instanceof AudioBusBox) ?? null
    }

    get midiEffects(): ReadonlyArray<AnyMIDIEffect> {return this.#midiChain.list()}
    get audioEffects(): ReadonlyArray<AnyAudioEffect> {return this.#audioChain.list()}

    addMIDIEffect<K extends keyof MIDIEffects>(key: K, props?: DeepPartial<MIDIEffects[K]>, index?: int): MIDIEffects[K] {
        Guard.oneOf(key, Object.keys(DeviceBoxes.MIDIEffectLabels), "key")
        return this.#midiChain.add(at => DeviceBoxes.createMIDIEffect(this.context.boxGraph, key, this.box.midiEffects, at),
            props, index) as unknown as MIDIEffects[K]
    }

    addAudioEffect<K extends keyof AudioEffects>(key: K, props?: DeepPartial<AudioEffects[K]>, index?: int): AudioEffects[K] {
        Guard.oneOf(key, Object.keys(DeviceBoxes.AudioEffectLabels), "key")
        return this.#audioChain.add(at => DeviceBoxes.createAudioEffect(this.context.boxGraph, key, this.box.audioEffects, at),
            props, index) as unknown as AudioEffects[K]
    }

    get tracks(): ReadonlyArray<AnyTrack> {return TrackImpls.list(this.context, this.box.tracks)}
    get noteTracks(): ReadonlyArray<NoteTrack> {
        return this.tracks.filter((track): track is NoteTrackImpl => track instanceof NoteTrackImpl)
    }
    get audioTracks(): ReadonlyArray<AudioTrack> {
        return this.tracks.filter((track): track is AudioTrackImpl => track instanceof AudioTrackImpl)
    }
    get valueTracks(): ReadonlyArray<ValueTrack> {
        return this.tracks.filter((track): track is ValueTrackImpl => track instanceof ValueTrackImpl)
    }

    addNoteTrack(props?: Partial<Pick<Track, "enabled">>, index?: int): NoteTrack {
        return Props.apply(TrackImpls.create(this.context, this.box.tracks, TrackType.Notes, this.box, index), props) as NoteTrack
    }

    addAudioTrack(props?: Partial<Pick<Track, "enabled">>, index?: int): AudioTrack {
        return Props.apply(TrackImpls.create(this.context, this.box.tracks, TrackType.Audio, this.box, index), props) as AudioTrack
    }

    addValueTrack<T extends Automatable>(target: T, parameter: ParameterPath<T>, props?: Partial<Pick<Track, "enabled">>, index?: int): ValueTrack {
        const field = AudioUnitImpls.automationField(target, parameter)
        const existing = this.#findValueTrack(field)
        if (isDefined(existing)) {return panic(new RangeError(`'${parameter}' is already automated by a track`))}
        return Props.apply(TrackImpls.create(this.context, this.box.tracks, TrackType.Value, field, index), props) as ValueTrack
    }

    valueTrack<T extends Automatable>(target: T, parameter: ParameterPath<T>): Nullable<ValueTrack> {
        return this.#findValueTrack(AudioUnitImpls.automationField(target, parameter)) ?? null
    }

    remove(): void {
        if (this.box.type.getValue() === AudioUnitType.Output) {return panic("The output unit cannot be removed")}
        this.context.edit(() => {
            const rootBox = this.context.skeleton.mandatoryBoxes.rootBox
            const index = this.index
            IndexedBox.removeOrder(rootBox.audioUnits, index)
            this.box.delete()
        })
    }

    #findValueTrack(field: AnyPrimitiveField): Optional<ValueTrack> {
        return this.valueTracks.find(track => (track as ValueTrackImpl).box.target.targetVertex.contains(field))
    }
}

export abstract class SendableAudioUnitFacade extends AudioUnitFacade {
    get sends(): ReadonlyArray<Send> {
        return IndexedBox.collectIndexedBoxes(this.box.auxSends)
            .map(box => SendImpl.wrap(this.context, asInstanceOf(box, AuxSendBox)))
    }

    addSend(target: AuxAudioUnit | GroupAudioUnit, props?: Partial<Pick<Send, "amount" | "pan" | "mode">>): Send {
        const busBox = Sends.validateTarget(target)
        if (busBox === this.optBusBox) {return panic(new RangeError("A unit cannot send to itself"))}
        return this.context.edit(() => {
            const index = this.box.auxSends.pointerHub.incoming().length
            const box = AuxSendBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.audioUnit.refer(this.box.auxSends)
                box.targetBus.refer(busBox.input)
                box.routing.setValue(AudioSendRouting.Post)
                box.sendGain.setValue(-6.0)
                box.index.setValue(index)
            })
            return Props.apply(SendImpl.wrap(this.context, box), props)
        })
    }
}

export class InstrumentAudioUnitImpl extends SendableAudioUnitFacade implements InstrumentAudioUnit {
    readonly kind = "instrument" as const

    constructor(context: Context, box: AudioUnitBox) {super(context, box)}

    get instrumentBox(): Box {
        return this.box.input.pointerHub.incoming().at(0)?.box ?? panic("Audio unit has no instrument")
    }

    get instrument(): AnyInstrumentImpl {return InstrumentImpls.wrap(this.context, this.instrumentBox)}

    get label(): string {return this.instrument.label}
    set label(value: string) {this.instrument.label = Guard.string(value, "label")}

    setInstrument<N extends keyof Instruments>(key: N, props?: DeepPartial<Instruments[N]>): Instruments[N] {
        Guard.oneOf(key, Object.keys(InstrumentFactories.Named), "key")
        return this.context.edit(() => {
            const previous = this.instrumentBox
            const label = this.label
            const trackType = InstrumentFactories.Named[key].trackType
            const previousTrackType = InstrumentFactories.Named[DeviceBoxes.instrumentKeyOf(previous.name)].trackType
            previous.delete()
            if (trackType !== previousTrackType) {
                this.box.capture.targetVertex.ifSome(vertex => vertex.box.delete())
                AudioUnitFactory.trackTypeToCapture(this.context.boxGraph, trackType)
                    .ifSome(capture => this.box.capture.refer(capture))
            }
            const instrumentBox = DeviceBoxes.createInstrument(this.context.boxGraph, key, this.box.input, label)
            return Props.apply(InstrumentImpls.wrap(this.context, instrumentBox), props) as unknown as Instruments[N]
        })
    }
}

export abstract class BusAudioUnitFacade extends SendableAudioUnitFacade {
    get label(): string {return this.busBox.label.getValue()}
    set label(value: string) {this.context.edit(() => this.busBox.label.setValue(Guard.string(value, "label")))}
    get icon(): string {return this.busBox.icon.getValue()}
    set icon(value: string) {this.context.edit(() => this.busBox.icon.setValue(AudioUnitImpls.validateIcon(value)))}
    get color(): string {return this.busBox.color.getValue()}
    set color(value: string) {this.context.edit(() => this.busBox.color.setValue(Guard.string(value, "color")))}
}

export class AuxAudioUnitImpl extends BusAudioUnitFacade implements AuxAudioUnit {
    readonly kind = "auxiliary" as const

    constructor(context: Context, box: AudioUnitBox) {super(context, box)}
}

export class GroupAudioUnitImpl extends BusAudioUnitFacade implements GroupAudioUnit {
    readonly kind = "group" as const

    constructor(context: Context, box: AudioUnitBox) {super(context, box)}
}

export class OutputAudioUnitImpl extends BusAudioUnitFacade implements OutputAudioUnit {
    readonly kind = "output" as const

    constructor(context: Context, box: AudioUnitBox) {super(context, box)}
}

export type AnyAudioUnitImpl = InstrumentAudioUnitImpl | AuxAudioUnitImpl | GroupAudioUnitImpl | OutputAudioUnitImpl

export namespace AudioUnitImpls {
    export const wrap = (context: Context, box: AudioUnitBox): AnyAudioUnitImpl => context.facade(box, () => {
        switch (box.type.getValue()) {
            case AudioUnitType.Instrument: return new InstrumentAudioUnitImpl(context, box)
            case AudioUnitType.Aux: return new AuxAudioUnitImpl(context, box)
            case AudioUnitType.Bus: return new GroupAudioUnitImpl(context, box)
            case AudioUnitType.Output: return new OutputAudioUnitImpl(context, box)
            default: return panic(`Unknown audio unit type '${box.type.getValue()}'`)
        }
    }) as AnyAudioUnitImpl

    export const list = (context: Context): ReadonlyArray<AnyAudioUnit> =>
        IndexedBox.collectIndexedBoxes(context.skeleton.mandatoryBoxes.rootBox.audioUnits, AudioUnitBox)
            .map(box => wrap(context, box))

    export const automationField = (target: unknown, parameter: unknown): AnyPrimitiveField => {
        if (typeof target !== "object" || isNull(target)) {
            return panic(new TypeError(`Expected an openDAW object as automation target, got ${Guard.describe(target)}`))
        }
        const field = Parameters.resolve(target, Guard.string(parameter, "parameter"))
        if (!field.pointerRules.accepts.includes(Pointers.Automation)) {
            return panic(new RangeError(`'${parameter}' cannot be automated`))
        }
        return field
    }

    export const modulationField = (target: unknown, parameter: unknown): Field<Pointers.Modulation> => {
        if (typeof target !== "object" || isNull(target)) {
            return panic(new TypeError(`Expected an openDAW object as modulation target, got ${Guard.describe(target)}`))
        }
        const field = Parameters.resolve(target, Guard.string(parameter, "parameter"))
        if (!field.pointerRules.accepts.includes(Pointers.Modulation)) {
            return panic(new RangeError(`'${parameter}' cannot be modulated`))
        }
        return field as unknown as Field<Pointers.Modulation>
    }

    export const validateIcon = (value: unknown): string => {
        const name = Guard.string(value, "icon")
        if (!Object.hasOwn(IconSymbol, name) || typeof IconSymbol[name as keyof typeof IconSymbol] !== "number") {
            return panic(new RangeError(`icon: '${name}' is not a known icon`))
        }
        return name
    }

    export const createInstrumentUnit = (context: Context, key: keyof Instruments, label: Optional<string>): InstrumentAudioUnitImpl => {
        Guard.oneOf(key, Object.keys(InstrumentFactories.Named), "key")
        return context.edit(() => {
            const {boxGraph, mandatoryBoxes: {rootBox}} = context.skeleton
            const factory = InstrumentFactories.Named[key]
            const existingNames = ProjectQueries.existingInstrumentNames(rootBox)
            const audioUnitBox = AudioUnitFactory.create(context.skeleton, AudioUnitType.Instrument,
                AudioUnitFactory.trackTypeToCapture(boxGraph, factory.trackType))
            const uniqueName = Strings.getUniqueName(existingNames, isDefined(label) ? Guard.string(label, "label") : factory.defaultName)
            DeviceBoxes.createInstrument(boxGraph, key, audioUnitBox.input, uniqueName)
            TrackBox.create(boxGraph, UUID.generate(), box => {
                box.index.setValue(0)
                box.type.setValue(factory.trackType)
                box.tracks.refer(audioUnitBox.tracks)
                box.target.refer(audioUnitBox)
            })
            return wrap(context, audioUnitBox) as InstrumentAudioUnitImpl
        })
    }

    export const createBusUnit = (context: Context, type: AudioUnitType.Aux | AudioUnitType.Bus,
                                  label: Optional<string>, icon: IconSymbol, color: string): AnyAudioUnitImpl =>
        context.edit(() => {
            const {boxGraph, mandatoryBoxes: {rootBox}} = context.skeleton
            const audioBusBox = AudioBusBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.audioBusses)
                box.label.setValue(isDefined(label) ? Guard.string(label, "label") : type === AudioUnitType.Aux ? "Aux" : "Group")
                box.icon.setValue(IconSymbol.toName(icon))
                box.color.setValue(color)
            })
            const audioUnitBox = AudioUnitFactory.create(context.skeleton, type, Option.None)
            audioBusBox.output.refer(audioUnitBox.input)
            return wrap(context, audioUnitBox)
        })
}
