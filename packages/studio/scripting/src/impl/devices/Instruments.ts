import {
    ApparatDeviceBox,
    AudioFileBox,
    CubedDeviceBox,
    InstrumentCompositeBox,
    InstrumentCompositeCellBox,
    MIDIOutputDeviceBox,
    MIDIOutputParameterBox,
    NanoDeviceBox,
    NeonDeviceBox,
    TubularDeviceBox,
    SurgeonDeviceBox,
    OpenDrumKickDeviceBox,
    OpenDrumSnareDeviceBox,
    OpenDrumClapDeviceBox,
    OpenDrumTomDeviceBox,
    OpenDrumRimDeviceBox,
    OpenDrumHatDeviceBox,
    OpenDrumShakerDeviceBox,
    OpenDrumCymbalDeviceBox,
    OpenDrumBellDeviceBox,
    OpenDrumPercDeviceBox,
    SurgeonPattern,
    SurgeonSound,
    PlayfieldDeviceBox,
    SamplerDeviceBox,
    SamplerGroupBox,
    SamplerModulationBox,
    SamplerZoneBox,
    SoundfontDeviceBox,
    SoundfontFileBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {BooleanField, Box, IndexedBox, Int32Field, PointerField, PointerTypes, StringField} from "@opendaw/lib-box"
import {ClassicWaveform} from "@opendaw/lib-dsp"
import {VoicingMode} from "@opendaw/studio-enums"
import {
    CellInstrument,
    CubedStep as CubedStepCodec,
    InstrumentFactories,
    InstrumentFactory,
    PlayfieldPads,
    SamplerZones
} from "@opendaw/studio-adapters"
import {asInstanceOf, bipolar, clamp, float, int, isDefined, isNull, Nullable, Option, panic, unitValue, UUID} from "@opendaw/lib-std"
import {
    AnyAudioEffect,
    AnyGroove,
    AnyMIDIEffect,
    Apparat,
    AudioEffects,
    Cubed,
    CubedPattern,
    CubedStep,
    DeepPartial,
    InstrumentAudioUnit,
    InstrumentComposite,
    InstrumentCompositeLayer,
    Instruments,
    LayerInstruments,
    MIDIEffects,
    MIDIOutput,
    MIDIOutputParameter,
    Nano,
    Neon,
    NeonEnvelope,
    NeonLine,
    NeonVibrato,
    Surgeon,
    OpenDrumKick,
    OpenDrumSnare,
    OpenDrumClap,
    OpenDrumTom,
    OpenDrumRim,
    OpenDrumHat,
    OpenDrumShaker,
    OpenDrumCymbal,
    OpenDrumBell,
    OpenDrumPerc,
    SurgeonValues,
    Tubular,
    TubularLfo,
    TubularOperator,
    TubularPitchEnvelope,
    PadInstruments,
    Playfield,
    PlayfieldPad,
    PlayfieldSlot,
    Sample,
    Sampler,
    SamplerEnvelope,
    SamplerFilter,
    SamplerGroup,
    SamplerLFO,
    SamplerModulation,
    SamplerZone,
    ScriptParameter,
    ScriptSample,
    Soundfont,
    SoundfontFile,
    Tape,
    Vaporisateur,
    VaporisateurLFO,
    VaporisateurNoise,
    VaporisateurOscillator
} from "../../Api"
import {Context} from "../Context"
import {Accessors, Facade, Props} from "../Common"
import {AnyPrimitiveField, Fields, FieldSpec} from "../Fields"
import {Guard} from "../Guard"
import {GrooveImpls} from "../Grooves"
import {AudioFiles} from "../AudioFiles"
import {EffectChain} from "./EffectChain"
import {DeviceBoxes} from "./DeviceBoxes"
import {AnyMIDIEffectImpl, MIDIEffectImpls} from "./MIDIEffects"
import {AnyAudioEffectImpl, AudioEffectImpls} from "./AudioEffects"
import {ScriptSupport} from "./ScriptDevices"
import {Facades} from "../Facades"
import {TrackImpls} from "../timeline/Tracks"
import {TrackType} from "@opendaw/studio-adapters"

export type InstrumentDeviceBox = Box & {
    readonly host: PointerField<PointerTypes>
    readonly label: StringField<PointerTypes>
    readonly icon: StringField<PointerTypes>
    readonly enabled: BooleanField<PointerTypes>
    readonly minimized: BooleanField<PointerTypes>
}

export abstract class InstrumentFacade<B extends InstrumentDeviceBox = InstrumentDeviceBox> extends Facade<B> {
    abstract readonly key: keyof Instruments
    declare label: string
    declare icon: string
    declare enabled: boolean
    declare minimized: boolean

    protected constructor(context: Context, box: B) {
        super(context, box)
        this.bind({label: box.label, icon: box.icon, enabled: box.enabled, minimized: box.minimized})
    }

    get audioUnit(): InstrumentAudioUnit {return Facades.audioUnitOf(this.context, this.box) as InstrumentAudioUnit}

    remove(): void {
        const hostBox = this.box.host.targetVertex.unwrap("instrument has no host").box
        if (hostBox instanceof InstrumentCompositeCellBox) {
            InstrumentCompositeLayerImpl.wrap(this.context, hostBox).remove()
        } else {
            this.audioUnit.remove()
        }
    }
}

export type AnyInstrumentImpl =
    | VaporisateurImpl | PlayfieldImpl | NanoImpl | SamplerImpl | SoundfontImpl | MIDIOutputImpl | TapeImpl | NeonImpl | TubularImpl | SurgeonImpl | CubedImpl
    | OpenDrumKickImpl | OpenDrumSnareImpl | OpenDrumClapImpl | OpenDrumTomImpl | OpenDrumRimImpl | OpenDrumHatImpl
    | OpenDrumShakerImpl | OpenDrumCymbalImpl | OpenDrumBellImpl | OpenDrumPercImpl
    | ApparatImpl | InstrumentCompositeImpl

export class VaporisateurImpl extends InstrumentFacade<VaporisateurDeviceBox> implements Vaporisateur {
    readonly key = "Vaporisateur" as const
    declare cutoff: float
    declare resonance: float
    declare filterOrder: 1 | 2 | 3 | 4
    declare filterEnvelope: bipolar
    declare filterKeyboard: bipolar
    declare attack: float
    declare decay: float
    declare sustain: unitValue
    declare release: float
    declare voicingMode: VoicingMode
    declare glideTime: unitValue
    declare unisonCount: 1 | 3 | 5
    declare unisonDetune: float
    declare unisonStereo: unitValue
    declare readonly lfo: VaporisateurLFO
    declare readonly oscillators: ReadonlyArray<VaporisateurOscillator>
    declare readonly noise: VaporisateurNoise

    constructor(context: Context, box: VaporisateurDeviceBox) {
        super(context, box)
        this.bind({
            cutoff: box.cutoff, resonance: box.resonance, filterOrder: box.filterOrder,
            filterEnvelope: box.filterEnvelope, filterKeyboard: box.filterKeyboard,
            attack: box.attack, decay: box.decay, sustain: box.sustain, release: box.release,
            voicingMode: box.voicingMode, glideTime: box.glideTime, unisonCount: box.unisonCount,
            unisonDetune: box.unisonDetune, unisonStereo: box.unisonStereo,
            lfo: {
                waveform: box.lfo.waveform, rate: box.lfo.rate, sync: box.lfo.sync,
                targetTune: box.lfo.targetTune, targetCutoff: box.lfo.targetCutoff, targetVolume: box.lfo.targetVolume
            },
            oscillators: box.oscillators.fields().map(osc =>
                ({waveform: osc.waveform, volume: osc.volume, octave: osc.octave, tune: osc.tune})),
            noise: {attack: box.noise.attack, hold: box.noise.hold, release: box.noise.release, volume: box.noise.volume}
        })
    }
}

// a slot is a Playfield pad cell playing a Nano
export class PlayfieldSlotImpl extends Facade<InstrumentCompositeCellBox> implements PlayfieldSlot {
    static wrap(context: Context, box: InstrumentCompositeCellBox): PlayfieldSlotImpl {
        return context.facade(box, () => new PlayfieldSlotImpl(context, box), slot =>
            !(slot instanceof PlayfieldSlotImpl) || slot.#boundNano !== PlayfieldSlotImpl.#nanoOf(box).unwrapOrNull())
    }

    static isSlot(box: InstrumentCompositeCellBox): boolean {
        return PlayfieldPads.isPad(box) && PlayfieldSlotImpl.#nanoOf(box).nonEmpty()
    }

    static #nanoOf(box: InstrumentCompositeCellBox): Option<NanoDeviceBox> {return PlayfieldPads.nanoBoxOf(box)}

    declare note: int
    declare key: int
    declare icon: string
    declare enabled: boolean
    declare minimized: boolean
    declare mute: boolean
    declare solo: boolean
    declare exclude: boolean
    declare polyphone: boolean
    declare pitch: float
    declare sampleStart: unitValue
    declare sampleEnd: unitValue
    declare attack: float
    declare release: float
    declare volume: float
    declare panning: bipolar
    readonly #midiChain: EffectChain<AnyMIDIEffectImpl>
    readonly #audioChain: EffectChain<AnyAudioEffectImpl>
    readonly #boundNano: Nullable<NanoDeviceBox>

    private constructor(context: Context, box: InstrumentCompositeCellBox) {
        super(context, box)
        const nano = PlayfieldSlotImpl.#nanoOf(box).unwrap("a slot plays a Nano")
        this.#boundNano = nano
        this.bind({note: box.index, key: box.key, minimized: box.minimized, mute: box.mute, solo: box.solo,
            exclude: box.exclude, volume: box.gain, panning: box.pan, icon: nano.icon, enabled: nano.enabled,
            polyphone: nano.polyphone, pitch: nano.tune, sampleStart: nano.sampleStart, sampleEnd: nano.sampleEnd,
            attack: nano.attack, release: nano.release})
        this.#midiChain = new EffectChain<AnyMIDIEffectImpl>(context, box.midiEffects, box => MIDIEffectImpls.wrap(context, box))
        this.#audioChain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    get playfield(): Playfield {
        const deviceBox = this.box.composite.targetVertex.unwrap("slot has no playfield").box
        return InstrumentImpls.wrap(this.context, deviceBox) as PlayfieldImpl
    }
    get sample(): Sample {
        const nano = this.#nano()
        return AudioFiles.toSample(this.context, asInstanceOf(nano.file.targetVertex.unwrap("slot has no file").box, AudioFileBox))
    }
    get gate(): 0 | 1 | 2 {
        const nano = this.#nano()
        return nano.loop.getValue() ? 2 : nano.oneShot.getValue() ? 0 : 1
    }
    set gate(value: 0 | 1 | 2) {
        const gate = Guard.int32({length: 3}, value, "gate")
        const nano = this.#nano()
        this.context.edit(() => {
            nano.loop.setValue(gate === 2)
            nano.oneShot.setValue(gate === 0)
        })
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

    #nano(): NanoDeviceBox {return PlayfieldSlotImpl.#nanoOf(this.box).unwrap("slot plays no sample")}
}

export class PlayfieldImpl extends InstrumentFacade<PlayfieldDeviceBox> implements Playfield {
    readonly key = "Playfield" as const

    constructor(context: Context, box: PlayfieldDeviceBox) {super(context, box)}

    get slots(): ReadonlyArray<PlayfieldSlot> {
        return PlayfieldPads.padsOf(this.box)
            .filter(box => PlayfieldSlotImpl.isSlot(box))
            .map(box => PlayfieldSlotImpl.wrap(this.context, box))
            .sort((a, b) => a.note - b.note)
    }

    slot(note: int): Nullable<PlayfieldSlot> {
        const index = Guard.integer(note, "note")
        return this.slots.find(slot => slot.note === index) ?? null
    }

    addSample(sample: Sample, props?: Partial<Omit<PlayfieldSlot, "uuid" | "playfield" | "sample" | "midiEffects" | "audioEffects" | "addMIDIEffect" | "addAudioEffect" | "remove">>): PlayfieldSlot {
        return this.context.edit(() => {
            const fileBox = AudioFiles.use(this.context, sample)
            const note = isDefined(props?.note) ? Guard.int32({min: 0, max: 127}, props.note, "note") : this.#nextFreeNote()
            const slotBox = PlayfieldPads.create(this.context.boxGraph, this.box, fileBox, note)
            const rest = Props.without(props, "note")
            return Props.apply(PlayfieldSlotImpl.wrap(this.context, slotBox), rest)
        })
    }

    get pads(): ReadonlyArray<PlayfieldPad> {
        return PlayfieldPads.padsOf(this.box)
            .filter(box => PlayfieldPadImpl.isPad(box))
            .map(box => PlayfieldPadImpl.wrap(this.context, box))
            .sort((first, second) => first.note - second.note)
    }

    addPad<K extends keyof PadInstruments>(key: K, props?: DeepPartial<PadInstruments[K]>, pad?: PadProps)
        : PlayfieldPad & {readonly instrument: PadInstruments[K]} {
        const factory: InstrumentFactory = InstrumentFactories.Named[guardPadInstrument(key)]
        return this.context.edit(() => {
            const note = isDefined(pad?.note) ? Guard.int32({min: 0, max: 127}, pad.note, "note") : this.#nextFreeNote()
            PlayfieldPads.padAt(this.box, note).ifSome(cell => cell.delete())
            const cellBox = PlayfieldPads.createCell(this.context.boxGraph, this.box, note)
            const instrumentBox = CellInstrument.create(this.context.boxGraph, cellBox, factory).result()
            Props.apply(InstrumentImpls.wrap(this.context, instrumentBox), props)
            return Props.apply(PlayfieldPadImpl.wrap(this.context, cellBox), Props.without(pad, "note")) as unknown as
                PlayfieldPad & {readonly instrument: PadInstruments[K]}
        })
    }

    #nextFreeNote(): int {
        const taken = new Set(PlayfieldPads.padsOf(this.box).map(box => box.index.getValue()))
        for (let note = 60; note < 128; note++) {if (!taken.has(note)) {return note}}
        for (let note = 59; note >= 0; note--) {if (!taken.has(note)) {return note}}
        return panic("All 128 notes are taken")
    }
}

type PadProps = Partial<Pick<PlayfieldPad, "note" | "key" | "gain" | "pan" | "mute" | "solo" | "exclude" | "minimized">>

const guardPadInstrument = (key: string): keyof PadInstruments => {
    Guard.oneOf(key, Object.entries(InstrumentFactories.Named)
        .filter(([, factory]) => InstrumentFactories.isPadInstrument(factory) && factory !== InstrumentFactories.Nano)
        .map(([name]) => name), "key")
    return key as keyof PadInstruments
}

// a pad is a Playfield pad cell playing any instrument but a Nano
export class PlayfieldPadImpl extends Facade<InstrumentCompositeCellBox> implements PlayfieldPad {
    static wrap(context: Context, box: InstrumentCompositeCellBox): PlayfieldPadImpl {
        return context.facade(box, () => new PlayfieldPadImpl(context, box), pad => !(pad instanceof PlayfieldPadImpl))
    }

    static isPad(box: InstrumentCompositeCellBox): boolean {
        return PlayfieldPads.isPad(box) && !PlayfieldSlotImpl.isSlot(box)
    }

    declare note: int
    declare key: int
    declare gain: float
    declare pan: bipolar
    declare mute: boolean
    declare solo: boolean
    declare exclude: boolean
    declare minimized: boolean
    readonly #midiChain: EffectChain<AnyMIDIEffectImpl>
    readonly #audioChain: EffectChain<AnyAudioEffectImpl>

    private constructor(context: Context, box: InstrumentCompositeCellBox) {
        super(context, box)
        this.bind({note: box.index, key: box.key, gain: box.gain, pan: box.pan, mute: box.mute, solo: box.solo,
            exclude: box.exclude, minimized: box.minimized})
        this.#midiChain = new EffectChain<AnyMIDIEffectImpl>(context, box.midiEffects, box => MIDIEffectImpls.wrap(context, box))
        this.#audioChain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    get playfield(): Playfield {
        const deviceBox = this.box.composite.targetVertex.unwrap("pad has no playfield").box
        return InstrumentImpls.wrap(this.context, deviceBox) as PlayfieldImpl
    }
    get instrument(): PadInstruments[keyof PadInstruments] {
        const instrumentBox = this.box.instrument.pointerHub.incoming().at(0)?.box ?? panic("Pad has no instrument")
        return InstrumentImpls.wrap(this.context, instrumentBox) as unknown as PadInstruments[keyof PadInstruments]
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
}

type LayerProps = Partial<Pick<InstrumentCompositeLayer, "gain" | "pan" | "mute" | "solo" | "minimized">>

const guardLayerInstrument = (key: string): keyof LayerInstruments => {
    Guard.oneOf(key, Object.entries(InstrumentFactories.Named)
        .filter(([, factory]) => InstrumentFactories.isLayerInstrument(factory)).map(([name]) => name), "key")
    return key as keyof LayerInstruments
}

export class InstrumentCompositeLayerImpl extends Facade<InstrumentCompositeCellBox> implements InstrumentCompositeLayer {
    static wrap(context: Context, box: InstrumentCompositeCellBox): InstrumentCompositeLayerImpl {
        return context.facade(box, () => new InstrumentCompositeLayerImpl(context, box),
            layer => !(layer instanceof InstrumentCompositeLayerImpl))
    }

    declare gain: float
    declare pan: bipolar
    declare mute: boolean
    declare solo: boolean
    declare minimized: boolean
    readonly #midiChain: EffectChain<AnyMIDIEffectImpl>
    readonly #audioChain: EffectChain<AnyAudioEffectImpl>

    private constructor(context: Context, box: InstrumentCompositeCellBox) {
        super(context, box)
        this.bind({gain: box.gain, pan: box.pan, mute: box.mute, solo: box.solo, minimized: box.minimized})
        this.#midiChain = new EffectChain<AnyMIDIEffectImpl>(context, box.midiEffects, box => MIDIEffectImpls.wrap(context, box))
        this.#audioChain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    get index(): int {return this.box.index.getValue()}
    get composite(): InstrumentComposite {
        const deviceBox = this.box.composite.targetVertex.unwrap("layer has no composite").box
        if (deviceBox instanceof PlayfieldDeviceBox) {return panic("a Playfield pad belongs to no Instrument Composite")}
        return InstrumentImpls.wrap(this.context, deviceBox) as InstrumentCompositeImpl
    }
    get instrument(): LayerInstruments[keyof LayerInstruments] {
        const instrumentBox = this.box.instrument.pointerHub.incoming().at(0)?.box ?? panic("Layer has no instrument")
        return InstrumentImpls.wrap(this.context, instrumentBox) as unknown as LayerInstruments[keyof LayerInstruments]
    }
    get midiEffects(): ReadonlyArray<AnyMIDIEffect> {return this.#midiChain.list()}
    get audioEffects(): ReadonlyArray<AnyAudioEffect> {return this.#audioChain.list()}

    setInstrument<K extends keyof LayerInstruments>(key: K, props?: DeepPartial<LayerInstruments[K]>): LayerInstruments[K] {
        const factory: InstrumentFactory = InstrumentFactories.Named[guardLayerInstrument(key)]
        if (!InstrumentFactories.fitsCell(this.box, factory)) {return panic(new TypeError(`${key} cannot be used as a pad`))}
        return this.context.edit(() => {
            const label = this.box.instrument.pointerHub.incoming().at(0)?.box
            const previousLabel = isDefined(label) && InstrumentImpls.isBox(label) ? label.label.getValue() : undefined
            const instrumentBox = CellInstrument.replace(this.context.boxGraph, this.box, factory, previousLabel).result()
            return Props.apply(InstrumentImpls.wrap(this.context, instrumentBox), props) as unknown as LayerInstruments[K]
        })
    }

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

    remove(): void {
        this.context.edit(() => {
            const compositeBox = asInstanceOf(this.box.composite.targetVertex.unwrap("layer has no composite").box, InstrumentCompositeBox)
            const survivors = IndexedBox.collectIndexedBoxes(compositeBox.cells).filter(box => box !== this.box)
            this.box.delete()
            survivors.forEach((box, index) => box.index.setValue(index))
        })
    }
}

export class InstrumentCompositeImpl extends InstrumentFacade<InstrumentCompositeBox> implements InstrumentComposite {
    readonly key = "InstrumentComposite" as const

    constructor(context: Context, box: InstrumentCompositeBox) {super(context, box)}

    get layers(): ReadonlyArray<InstrumentCompositeLayer> {
        return this.box.cells.pointerHub.incoming()
            .map(({box}) => InstrumentCompositeLayerImpl.wrap(this.context, asInstanceOf(box, InstrumentCompositeCellBox)))
            .sort((left, right) => left.index - right.index)
    }

    addLayer<K extends keyof LayerInstruments>(key: K, props?: DeepPartial<LayerInstruments[K]>, layer?: LayerProps)
        : InstrumentCompositeLayer & {readonly instrument: LayerInstruments[K]} {
        const guarded = guardLayerInstrument(key)
        return this.context.edit(() => {
            const index = this.box.cells.pointerHub.incoming().length
            const cellBox = InstrumentCompositeCellBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.composite.refer(this.box.cells)
                box.index.setValue(index)
            })
            const instrumentBox = CellInstrument.create(this.context.boxGraph, cellBox, InstrumentFactories.Named[guarded] as InstrumentFactory).result()
            Props.apply(InstrumentImpls.wrap(this.context, instrumentBox), props)
            return Props.apply(InstrumentCompositeLayerImpl.wrap(this.context, cellBox), layer) as unknown as
                InstrumentCompositeLayer & {readonly instrument: LayerInstruments[K]}
        })
    }
}

export class NanoImpl extends InstrumentFacade<NanoDeviceBox> implements Nano {
    readonly key = "Nano" as const
    declare volume: float
    declare octave: int
    declare tune: float
    declare rootKey: int
    declare attack: float
    declare release: float
    declare sampleStart: unitValue
    declare sampleEnd: unitValue
    declare loop: boolean
    declare loopFade: float
    declare loopStart: unitValue
    declare loopEnd: unitValue
    declare panning: bipolar
    declare polyphone: boolean
    declare oneShot: boolean
    declare fixedPitch: boolean
    declare tail: boolean

    constructor(context: Context, box: NanoDeviceBox) {
        super(context, box)
        this.bind({
            volume: box.volume, octave: box.octave, tune: box.tune, rootKey: box.rootKey, attack: box.attack, release: box.release,
            sampleStart: box.sampleStart, sampleEnd: box.sampleEnd, loop: box.loop, loopFade: box.loopFade,
            loopStart: box.loopStart, loopEnd: box.loopEnd, panning: box.panning, polyphone: box.polyphone,
            oneShot: box.oneShot, fixedPitch: box.fixedPitch, tail: box.tail
        })
    }

    get sample(): Nullable<Sample> {
        const fileBox = Accessors.pointerBox(this.box.file, AudioFileBox)
        return isNull(fileBox) ? null : AudioFiles.toSample(this.context, fileBox)
    }
    set sample(sample: Nullable<Sample>) {
        AudioFiles.assign(this.context, this.box.file, () => isNull(sample) ? null : AudioFiles.use(this.context, sample))
    }
}

export class SamplerGroupImpl extends Facade<SamplerGroupBox> implements SamplerGroup {
    static wrap(context: Context, box: SamplerGroupBox): SamplerGroupImpl {
        return context.facade(box, () => new SamplerGroupImpl(context, box))
    }

    declare label: string
    declare roundRobin: 0 | 1 | 2
    declare choke: int
    declare trigger: 0 | 1

    private constructor(context: Context, box: SamplerGroupBox) {
        super(context, box)
        this.bind({label: box.label, roundRobin: box.roundRobin, choke: box.choke, trigger: box.trigger})
    }

    get zones(): ReadonlyArray<SamplerZone> {
        return this.box.zones.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, SamplerZoneBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
            .map(box => SamplerZoneImpl.wrap(this.context, box))
    }

    remove(): void {
        this.context.edit(() => {
            const device = asInstanceOf(this.box.device.targetVertex.unwrap("group has no sampler").box, SamplerDeviceBox)
            if (!SamplerZones.removeGroup(device, this.box)) {return panic("The last group of a Sampler cannot be removed")}
        })
    }
}

export class SamplerZoneImpl extends Facade<SamplerZoneBox> implements SamplerZone {
    static wrap(context: Context, box: SamplerZoneBox): SamplerZoneImpl {
        return context.facade(box, () => new SamplerZoneImpl(context, box))
    }

    declare enabled: boolean
    declare keyLow: int
    declare keyHigh: int
    declare keyFade: int
    declare rootKey: int
    declare velocityLow: int
    declare velocityHigh: int
    declare velocityFade: int
    declare transpose: int
    declare tune: float
    declare keyTrack: unitValue
    declare gain: float
    declare panning: bipolar
    declare sequence: int
    declare reverse: boolean
    declare oneShot: boolean
    declare sampleStart: int
    declare sampleEnd: int
    declare loopMode: 0 | 1 | 2
    declare loopStart: int
    declare loopEnd: int
    declare loopFade: float
    declare loopAlternate: boolean

    private constructor(context: Context, box: SamplerZoneBox) {
        super(context, box)
        this.bind({
            enabled: box.enabled, keyLow: box.keyLow, keyHigh: box.keyHigh, keyFade: box.keyFade, rootKey: box.rootKey,
            velocityLow: box.velocityLow, velocityHigh: box.velocityHigh, velocityFade: box.velocityFade,
            transpose: box.transpose, tune: box.tune, keyTrack: box.keyTrack, gain: box.gain, panning: box.panning,
            sequence: box.sequence, reverse: box.reverse, oneShot: box.oneShot, sampleStart: box.sampleStart,
            sampleEnd: box.sampleEnd, loopMode: box.loopMode, loopStart: box.loopStart, loopEnd: box.loopEnd,
            loopFade: box.loopFade, loopAlternate: box.loopAlternate
        })
    }

    get sample(): Sample {
        return AudioFiles.toSample(this.context, asInstanceOf(this.box.file.targetVertex.unwrap("zone has no file").box, AudioFileBox))
    }
    set sample(sample: Sample) {AudioFiles.assign(this.context, this.box.file, () => AudioFiles.use(this.context, sample))}
    get group(): SamplerGroup {
        return SamplerGroupImpl.wrap(this.context,
            asInstanceOf(this.box.group.targetVertex.unwrap("zone has no group").box, SamplerGroupBox))
    }
    set group(group: SamplerGroup) {this.context.edit(() => this.box.group.refer(this.#groupBoxOf(group).zones))}

    remove(): void {this.context.edit(() => SamplerZones.remove([this.box]))}

    #groupBoxOf(group: SamplerGroup): SamplerGroupBox {
        if (!(group instanceof SamplerGroupImpl)) {return panic(new TypeError(`group: expected a SamplerGroup, got ${Guard.describe(group)}`))}
        const sameSampler = group.box.device.targetVertex.unwrapOrNull()?.box === this.box.device.targetVertex.unwrapOrNull()?.box
        return sameSampler ? group.box : panic("group: belongs to another Sampler")
    }
}

export class SamplerModulationImpl extends Facade<SamplerModulationBox> implements SamplerModulation {
    static wrap(context: Context, box: SamplerModulationBox): SamplerModulationImpl {
        return context.facade(box, () => new SamplerModulationImpl(context, box))
    }

    declare source: 0 | 1 | 2 | 3 | 4 | 5 | 6
    declare target: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    declare amount: bipolar

    private constructor(context: Context, box: SamplerModulationBox) {
        super(context, box)
        this.bind({source: box.source, target: box.target, amount: box.amount})
    }
}

export class SamplerImpl extends InstrumentFacade<SamplerDeviceBox> implements Sampler {
    readonly key = "Sampler" as const
    declare voices: int
    declare glide: float
    declare legato: boolean
    declare octave: int
    declare transpose: int
    declare tune: float
    declare volume: float
    declare panning: bipolar
    declare mono: unitValue
    declare readonly filter: SamplerFilter
    declare readonly ampEnvelope: SamplerEnvelope
    declare readonly modEnvelope: SamplerEnvelope
    declare readonly lfos: ReadonlyArray<SamplerLFO>

    constructor(context: Context, box: SamplerDeviceBox) {
        super(context, box)
        const envelope = (field: SamplerDeviceBox["ampEnvelope"] | SamplerDeviceBox["modEnvelope"]): FieldSpec => ({
            delay: field.delay, attack: field.attack, hold: field.hold, decay: field.decay, sustain: field.sustain, release: field.release
        })
        const lfo = (field: SamplerDeviceBox["lfoA"] | SamplerDeviceBox["lfoB"]): FieldSpec => ({
            shape: field.shape, rate: field.rate, delay: field.delay, fade: field.fade, sync: field.sync, restart: field.restart
        })
        this.bind({
            voices: box.voices, glide: box.glide, legato: box.legato, octave: box.octave, transpose: box.transpose,
            tune: box.tune, volume: box.volume, panning: box.panning, mono: box.mono,
            filter: {type: box.filterType, cutoff: box.cutoff, resonance: box.resonance},
            ampEnvelope: envelope(box.ampEnvelope), modEnvelope: envelope(box.modEnvelope),
            lfos: [lfo(box.lfoA), lfo(box.lfoB)]
        })
    }

    get groups(): ReadonlyArray<SamplerGroup> {
        return this.#groupBoxes().map(box => SamplerGroupImpl.wrap(this.context, box))
    }
    get zones(): ReadonlyArray<SamplerZone> {
        return SamplerZones.zonesOf(this.box)
            .toSorted((left, right) => left.index.getValue() - right.index.getValue())
            .map(box => SamplerZoneImpl.wrap(this.context, box))
    }
    get modulations(): ReadonlyArray<SamplerModulation> {
        return this.#modulationBoxes().map(box => SamplerModulationImpl.wrap(this.context, box))
    }

    addGroup(props?: Partial<Pick<SamplerGroup, "label" | "roundRobin" | "choke" | "trigger">>): SamplerGroup {
        return this.context.edit(() => {
            const label = `Group ${this.#groupBoxes().length + 1}`
            return Props.apply(SamplerGroupImpl.wrap(this.context, SamplerZones.createGroup(this.context.boxGraph, this.box, label)), props)
        })
    }

    addZone(sample: Sample, props?: Partial<Omit<SamplerZone, "uuid" | "sample" | "remove">>): SamplerZone {
        return this.context.edit(() => {
            const fileBox = AudioFiles.use(this.context, sample)
            const groupBox = this.#groupBoxes().at(0) ?? SamplerZones.createGroup(this.context.boxGraph, this.box, "Group 1")
            const zoneBox = SamplerZones.create(this.context.boxGraph, this.box, groupBox, fileBox)
            return Props.apply(SamplerZoneImpl.wrap(this.context, zoneBox), props)
        })
    }

    addModulation(source: SamplerModulation["source"], target: SamplerModulation["target"], amount: bipolar): SamplerModulation {
        return this.context.edit(() => {
            const index = this.#modulationBoxes().reduce((highest, box) => Math.max(highest, box.index.getValue() + 1), 0)
            const box = SamplerModulationBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.device.refer(this.box.modulations)
                box.index.setValue(index)
            })
            return Props.apply(SamplerModulationImpl.wrap(this.context, box), {source, target, amount})
        })
    }

    #groupBoxes(): ReadonlyArray<SamplerGroupBox> {
        return this.box.groups.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, SamplerGroupBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
    }

    #modulationBoxes(): ReadonlyArray<SamplerModulationBox> {
        return this.box.modulations.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, SamplerModulationBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
    }
}

export class SoundfontImpl extends InstrumentFacade<SoundfontDeviceBox> implements Soundfont {
    readonly key = "Soundfont" as const
    declare presetIndex: int

    constructor(context: Context, box: SoundfontDeviceBox) {
        super(context, box)
        this.bind({presetIndex: box.presetIndex})
    }

    get file(): Nullable<SoundfontFile> {
        const fileBox = Accessors.pointerBox(this.box.file, SoundfontFileBox)
        return isNull(fileBox) ? null : AudioFiles.toSoundfont(fileBox)
    }
    set file(file: Nullable<SoundfontFile>) {
        AudioFiles.assign(this.context, this.box.file, () => isNull(file) ? null : AudioFiles.useSoundfont(this.context.boxGraph, file))
    }
}

export class MIDIOutputParameterImpl extends Facade<MIDIOutputParameterBox> implements MIDIOutputParameter {
    static wrap(context: Context, box: MIDIOutputParameterBox): MIDIOutputParameterImpl {
        return context.facade(box, () => new MIDIOutputParameterImpl(context, box))
    }

    declare label: string
    declare controller: int
    declare value: unitValue

    private constructor(context: Context, box: MIDIOutputParameterBox) {
        super(context, box)
        this.bind({label: box.label, controller: box.controller, value: box.value})
    }

    remove(): void {
        this.context.edit(() => {
            const tracks = Facades.audioUnitBoxOf(this.box).tracks
            this.box.delete()
            TrackImpls.reindex(tracks)
        })
    }
}

export class MIDIOutputImpl extends InstrumentFacade<MIDIOutputDeviceBox> implements MIDIOutput {
    readonly key = "MIDIOutput" as const
    declare channel: int

    constructor(context: Context, box: MIDIOutputDeviceBox) {
        super(context, box)
        this.bind({channel: box.channel})
    }

    get parameters(): ReadonlyArray<MIDIOutputParameter> {
        return this.box.parameters.pointerHub.incoming()
            .map(({box}) => MIDIOutputParameterImpl.wrap(this.context, asInstanceOf(box, MIDIOutputParameterBox)))
    }

    addParameter(props?: Partial<Pick<MIDIOutputParameter, "label" | "controller" | "value">>): MIDIOutputParameter {
        return this.context.edit(() => {
            const box = MIDIOutputParameterBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.owner.refer(this.box.parameters)
                box.label.setValue("CC")
            })
            const audioUnitBox = Facades.audioUnitBoxOf(this.box)
            TrackImpls.create(this.context, audioUnitBox.tracks, TrackType.Value, box.value, null)
            return Props.apply(MIDIOutputParameterImpl.wrap(this.context, box), props)
        })
    }
}

export class TapeImpl extends InstrumentFacade<TapeDeviceBox> implements Tape {
    readonly key = "Tape" as const
    declare flutter: unitValue
    declare wow: unitValue
    declare noise: unitValue
    declare saturation: unitValue

    constructor(context: Context, box: TapeDeviceBox) {
        super(context, box)
        this.bind({flutter: box.flutter, wow: box.wow, noise: box.noise, saturation: box.saturation})
    }
}

export class NeonImpl extends InstrumentFacade<NeonDeviceBox> implements Neon {
    readonly key = "Neon" as const
    declare lineSelect: 0 | 1 | 2 | 3
    declare modulation: 0 | 1 | 2
    declare octave: int
    declare detune: float
    declare glideTime: unitValue
    declare tune: float
    declare voicingMode: VoicingMode
    declare readonly vibrato: NeonVibrato
    declare readonly lines: ReadonlyArray<NeonLine>
    declare readonly envelopes: ReadonlyArray<NeonEnvelope>

    constructor(context: Context, box: NeonDeviceBox) {
        super(context, box)
        const envelope = (field: NeonDeviceBox["envelopes"] extends { fields(): ReadonlyArray<infer E> } ? E : never): FieldSpec => ({
            rate1: field.rate1, rate2: field.rate2, rate3: field.rate3, rate4: field.rate4,
            rate5: field.rate5, rate6: field.rate6, rate7: field.rate7, rate8: field.rate8,
            level1: field.level1, level2: field.level2, level3: field.level3, level4: field.level4,
            level5: field.level5, level6: field.level6, level7: field.level7, level8: field.level8,
            sustain: field.sustain, end: field.end
        })
        this.bind({
            lineSelect: box.lineSelect, modulation: box.modulation, octave: box.octave, detune: box.detune,
            glideTime: box.glideTime, tune: box.tune, voicingMode: box.voicingMode,
            vibrato: {wave: box.vibrato.wave, delay: box.vibrato.delay, rate: box.vibrato.rate, depth: box.vibrato.depth},
            lines: box.lines.fields().map(line =>
                ({wave1: line.wave1, wave2: line.wave2, dcwKeyFollow: line.dcwKeyFollow, dcaKeyFollow: line.dcaKeyFollow})),
            envelopes: box.envelopes.fields().map(envelope)
        })
    }
}

export class TubularImpl extends InstrumentFacade<TubularDeviceBox> implements Tubular {
    readonly key = "Tubular" as const
    declare cutoff: unitValue
    declare resonance: unitValue
    declare volume: unitValue
    declare voicingMode: VoicingMode
    declare tune: float
    declare algorithm: int
    declare feedback: int
    declare oscKeySync: 0 | 1
    declare readonly lfo: TubularLfo
    declare pitchModSens: int
    declare transpose: int
    declare readonly pitchEnvelope: TubularPitchEnvelope
    declare readonly operators: ReadonlyArray<TubularOperator>

    constructor(context: Context, box: TubularDeviceBox) {
        super(context, box)
        this.bind({
            cutoff: box.cutoff, resonance: box.resonance, volume: box.volume, voicingMode: box.voicingMode, tune: box.tune,
            algorithm: box.algorithm, feedback: box.feedback, oscKeySync: box.oscKeySync,
            lfo: {speed: box.lfo.speed, delay: box.lfo.delay, pmDepth: box.lfo.pmDepth, amDepth: box.lfo.amDepth, sync: box.lfo.sync, wave: box.lfo.wave},
            pitchModSens: box.pitchModSens, transpose: box.transpose,
            pitchEnvelope: {
                rate1: box.pitchEnvelope.rate1, rate2: box.pitchEnvelope.rate2, rate3: box.pitchEnvelope.rate3, rate4: box.pitchEnvelope.rate4,
                level1: box.pitchEnvelope.level1, level2: box.pitchEnvelope.level2, level3: box.pitchEnvelope.level3, level4: box.pitchEnvelope.level4
            },
            operators: box.operators.fields().map(operator => ({
                rate1: operator.rate1, rate2: operator.rate2, rate3: operator.rate3, rate4: operator.rate4,
                level1: operator.level1, level2: operator.level2, level3: operator.level3, level4: operator.level4,
                breakPoint: operator.breakPoint, leftDepth: operator.leftDepth, rightDepth: operator.rightDepth,
                leftCurve: operator.leftCurve, rightCurve: operator.rightCurve, rateScaling: operator.rateScaling,
                ampModSens: operator.ampModSens, velocitySens: operator.velocitySens, outputLevel: operator.outputLevel,
                mode: operator.mode, coarse: operator.coarse, fine: operator.fine, detune: operator.detune, enabled: operator.enabled
            }))
        })
    }
}

// the fields of a Surgeon value set, the live controls and a stored pattern have the same ones
const surgeonValues = (source: SurgeonSound | SurgeonPattern) => ({
        rate: source.rate, steps: source.steps, seed: source.seed, mutate: source.mutate, range: source.range,
        density: source.density, tie: source.tie, slide: source.slide, accent: source.accent,
        restart: source.restart, offset: source.offset,
        laneASteps: source.laneASteps, laneASeed: source.laneASeed, laneAMutate: source.laneAMutate,
        laneBSteps: source.laneBSteps, laneBSeed: source.laneBSeed, laneBMutate: source.laneBMutate,
        laneCSteps: source.laneCSteps, laneCSeed: source.laneCSeed, laneCMutate: source.laneCMutate,
        laneDSteps: source.laneDSteps, laneDSeed: source.laneDSeed, laneDMutate: source.laneDMutate,
        firstRatio: source.firstRatio, feedback: source.feedback, secondRatio: source.secondRatio,
        secondDepth: source.secondDepth, wave: source.wave, depth: source.depth, strike: source.strike,
        strikeDecay: source.strikeDecay, fold: source.fold, foldPlace: source.foldPlace, length: source.length,
        held: source.held, sineGain: source.sineGain, sinePitch: source.sinePitch, glide: source.glide,
        velocity: source.velocity, firstRatioA: source.firstRatioA, firstRatioB: source.firstRatioB,
        firstRatioC: source.firstRatioC, firstRatioD: source.firstRatioD, feedbackA: source.feedbackA,
        feedbackB: source.feedbackB, feedbackC: source.feedbackC, feedbackD: source.feedbackD,
        secondRatioA: source.secondRatioA, secondRatioB: source.secondRatioB, secondRatioC: source.secondRatioC,
        secondRatioD: source.secondRatioD, secondDepthA: source.secondDepthA, secondDepthB: source.secondDepthB,
        secondDepthC: source.secondDepthC, secondDepthD: source.secondDepthD, waveA: source.waveA,
        waveB: source.waveB, waveC: source.waveC, waveD: source.waveD, depthA: source.depthA, depthB: source.depthB,
        depthC: source.depthC, depthD: source.depthD, strikeA: source.strikeA, strikeB: source.strikeB,
        strikeC: source.strikeC, strikeD: source.strikeD, strikeDecayA: source.strikeDecayA,
        strikeDecayB: source.strikeDecayB, strikeDecayC: source.strikeDecayC, strikeDecayD: source.strikeDecayD,
        foldA: source.foldA, foldB: source.foldB, foldC: source.foldC, foldD: source.foldD,
        foldPlaceA: source.foldPlaceA, foldPlaceB: source.foldPlaceB, foldPlaceC: source.foldPlaceC,
        foldPlaceD: source.foldPlaceD, lengthA: source.lengthA, lengthB: source.lengthB, lengthC: source.lengthC,
        lengthD: source.lengthD, heldA: source.heldA, heldB: source.heldB, heldC: source.heldC, heldD: source.heldD,
        sineGainA: source.sineGainA, sineGainB: source.sineGainB, sineGainC: source.sineGainC,
        sineGainD: source.sineGainD, sinePitchA: source.sinePitchA, sinePitchB: source.sinePitchB,
        sinePitchC: source.sinePitchC, sinePitchD: source.sinePitchD, glideA: source.glideA, glideB: source.glideB,
        glideC: source.glideC, glideD: source.glideD, velocityA: source.velocityA, velocityB: source.velocityB,
        velocityC: source.velocityC, velocityD: source.velocityD
})

export class SurgeonImpl extends InstrumentFacade<SurgeonDeviceBox> implements Surgeon {
    readonly key = "Surgeon" as const
    declare tune: float
    declare volume: float
    declare slot: int
    declare readonly live: SurgeonValues
    declare readonly patterns: ReadonlyArray<SurgeonValues>

    constructor(context: Context, box: SurgeonDeviceBox) {
        super(context, box)
        const live = surgeonValues(box.live)
        const stored = box.patterns.fields().map(surgeonValues)
        const selected = new Map<AnyPrimitiveField, readonly [int, AnyPrimitiveField]>(stored.flatMap((pattern, index) =>
            Object.entries(pattern).map(([key, field]): [AnyPrimitiveField, readonly [int, AnyPrimitiveField]] =>
                [field, [index, live[key as keyof typeof live]]])))
        this.bind({tune: box.tune, volume: box.volume, slot: box.slot, live})
        Fields.bind(context, this, {patterns: stored}, "", field => {
            const entry = selected.get(field)
            return isDefined(entry) && entry[0] === box.pattern.getValue() ? entry[1] : field
        })
    }

    get pattern(): int {return this.box.pattern.getValue()}

    grooveOf(pattern: int): Nullable<AnyGroove> {return GrooveImpls.read(this.context, this.#patternGroove(pattern, "grooveOf"))}

    setGroove(pattern: int, groove: Nullable<AnyGroove>): void {
        GrooveImpls.write(this.context, this.#patternGroove(pattern, "setGroove"), groove)
    }

    #patternGroove(pattern: int, name: string) {
        const patterns = this.box.patterns.fields()
        return patterns[Guard.int32({length: patterns.length}, pattern, name)].groove
    }

    select(pattern: int): void {
        const index = Guard.int32({length: this.box.patterns.fields().length}, pattern, "select")
        this.context.edit(() => {
            const {slot, pattern: selected, live, patterns} = this.box
            const left = selected.getValue()
            slot.setValue(index)
            if (index === left) {return}
            const from = surgeonValues(patterns.fields()[left])
            const into = surgeonValues(patterns.fields()[index])
            Object.entries(surgeonValues(live)).forEach(([name, field]) => {
                const key = name as keyof typeof from
                from[key].setValue(field.getValue())
                field.setValue(into[key].getValue())
            })
            selected.setValue(index)
        })
    }
}

const createCubedStep = (context: Context, field: Int32Field, name: string): CubedStep => {
    const read = () => CubedStepCodec.unpack(field.getValue())
    const write = (step: CubedStep) => context.edit(() => field.setValue(CubedStepCodec.pack(step)))
    return Object.freeze({
        get note(): int {return read().note},
        set note(value: int) {write({...read(), note: Guard.int32({min: 0, max: 127}, value, `${name}.note`)})},
        get active(): boolean {return read().active},
        set active(value: boolean) {write({...read(), active: Guard.boolean(value, `${name}.active`)})},
        get slide(): boolean {return read().slide},
        set slide(value: boolean) {write({...read(), slide: Guard.boolean(value, `${name}.slide`)})},
        get accent(): boolean {return read().accent},
        set accent(value: boolean) {write({...read(), accent: Guard.boolean(value, `${name}.accent`)})}
    })
}

const createCubedPattern = (context: Context, pattern: CubedDeviceBox["patterns"] extends { fields(): ReadonlyArray<infer P> } ? P : never, index: int): CubedPattern => {
    const steps = Object.freeze(pattern.steps.fields()
        .map((field, stepIndex) => createCubedStep(context, field, `patterns.${index}.steps.${stepIndex}`)))
    const target = {
        steps,
        setSteps: (values: ReadonlyArray<Partial<CubedStep>>): void => context.edit(() => {
            if (!Array.isArray(values)) {return panic(new TypeError("setSteps: expected an array"))}
            if (values.length > steps.length) {return panic(new RangeError(`setSteps: at most ${steps.length} steps`))}
            values.forEach((value, stepIndex) => Props.apply(steps[stepIndex], value, `steps.${stepIndex}`))
            pattern.length.setValue(clamp(values.length, 1, steps.length))
        })
    }
    Fields.bind(context, target, {length: pattern.length}, `patterns.${index}.`)
    return target as unknown as CubedPattern
}

export class CubedImpl extends InstrumentFacade<CubedDeviceBox> implements Cubed {
    readonly key = "Cubed" as const
    declare tuning: float
    declare cutoff: unitValue
    declare resonance: unitValue
    declare envMod: unitValue
    declare decay: unitValue
    declare accent: unitValue
    declare volume: float
    declare waveform: 0 | 1
    declare patternIndex: int
    readonly patterns: ReadonlyArray<CubedPattern>

    constructor(context: Context, box: CubedDeviceBox) {
        super(context, box)
        this.bind({
            tuning: box.tuning, cutoff: box.cutoff, resonance: box.resonance, envMod: box.envMod,
            decay: box.decay, accent: box.accent, volume: box.volume, waveform: box.waveform,
            patternIndex: box.patternIndex
        })
        this.patterns = Object.freeze(box.patterns.fields().map((pattern, index) => createCubedPattern(context, pattern, index)))
    }

    get groove(): Nullable<AnyGroove> {return GrooveImpls.read(this.context, this.box.groove)}
    set groove(value: Nullable<AnyGroove>) {GrooveImpls.write(this.context, this.box.groove, value)}
}

export class ApparatImpl extends InstrumentFacade<ApparatDeviceBox> implements Apparat {
    readonly key = "Apparat" as const
    readonly #script: ScriptSupport

    constructor(context: Context, box: ApparatDeviceBox) {
        super(context, box)
        this.#script = new ScriptSupport(context, box, "apparat")
    }

    get code(): string {return this.#script.code}
    set code(source: string) {this.#script.code = source}
    get parameters(): ReadonlyArray<ScriptParameter> {return this.#script.parameters}
    get samples(): ReadonlyArray<ScriptSample> {return this.#script.samples}
    parameter(label: string): ScriptParameter {return this.#script.parameter(label)}
    sample(label: string): ScriptSample {return this.#script.sample(label)}
}

export class OpenDrumKickImpl extends InstrumentFacade<OpenDrumKickDeviceBox> implements OpenDrumKick {
    readonly key = "OpenDrumKick" as const
    declare tune: float
    declare pitch: float
    declare sweep: float
    declare drift: float
    declare decay: float
    declare punch: bipolar
    declare shape: unitValue
    declare skin: unitValue
    declare click: unitValue
    declare tone: float
    declare noise: unitValue
    declare drive: float
    declare rumble: unitValue
    declare length: int
    declare duck: unitValue
    declare bright: unitValue
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumKickDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, pitch: box.pitch, sweep: box.sweep, drift: box.drift, decay: box.decay, punch: box.punch,
            shape: box.shape, skin: box.skin, click: box.click, tone: box.tone, noise: box.noise, drive: box.drive,
            rumble: box.rumble, length: box.length, duck: box.duck, bright: box.bright, volume: box.volume,
            velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumSnareImpl extends InstrumentFacade<OpenDrumSnareDeviceBox> implements OpenDrumSnare {
    readonly key = "OpenDrumSnare" as const
    declare tune: float
    declare ratio: float
    declare balance: unitValue
    declare pitch: float
    declare sweep: float
    declare decay: float
    declare punch: bipolar
    declare shape: unitValue
    declare level: float
    declare wireDecay: float
    declare width: unitValue
    declare curve: bipolar
    declare click: unitValue
    declare tone: float
    declare skin: unitValue
    declare drive: float
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumSnareDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, ratio: box.ratio, balance: box.balance, pitch: box.pitch, sweep: box.sweep,
            decay: box.decay, punch: box.punch, shape: box.shape, level: box.level, wireDecay: box.wireDecay,
            width: box.width, curve: box.curve, click: box.click, tone: box.tone, skin: box.skin, drive: box.drive,
            volume: box.volume, velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumClapImpl extends InstrumentFacade<OpenDrumClapDeviceBox> implements OpenDrumClap {
    readonly key = "OpenDrumClap" as const
    declare hands: int
    declare gap: float
    declare last: float
    declare spread: unitValue
    declare attack: float
    declare decay: float
    declare snap: unitValue
    declare drive: float
    declare tone: float
    declare resonance: unitValue
    declare room: float
    declare roomDecay: float
    declare tail: unitValue
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumClapDeviceBox) {
        super(context, box)
        this.bind({
            hands: box.hands, gap: box.gap, last: box.last, spread: box.spread, attack: box.attack, decay: box.decay,
            snap: box.snap, drive: box.drive, tone: box.tone, resonance: box.resonance, room: box.room,
            roomDecay: box.roomDecay, tail: box.tail, volume: box.volume, velocity: box.velocity, play: box.play,
            panning: box.panning
        })
    }
}

export class OpenDrumTomImpl extends InstrumentFacade<OpenDrumTomDeviceBox> implements OpenDrumTom {
    readonly key = "OpenDrumTom" as const
    declare tune: float
    declare pitch: float
    declare sweep: float
    declare drift: float
    declare decay: float
    declare punch: bipolar
    declare shape: unitValue
    declare sub: unitValue
    declare ratio: float
    declare top: unitValue
    declare length: float
    declare drive: float
    declare noise: float
    declare noiseDecay: float
    declare color: unitValue
    declare air: unitValue
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumTomDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, pitch: box.pitch, sweep: box.sweep, drift: box.drift, decay: box.decay, punch: box.punch,
            shape: box.shape, sub: box.sub, ratio: box.ratio, top: box.top, length: box.length, drive: box.drive,
            noise: box.noise, noiseDecay: box.noiseDecay, color: box.color, air: box.air, volume: box.volume,
            velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumRimImpl extends InstrumentFacade<OpenDrumRimDeviceBox> implements OpenDrumRim {
    readonly key = "OpenDrumRim" as const
    declare tune: float
    declare ratio: float
    declare balance: unitValue
    declare high: unitValue
    declare highRatio: float
    declare ring: float
    declare ringHigh: float
    declare decay: float
    declare punch: bipolar
    declare drive: float
    declare hard: unitValue
    declare click: unitValue
    declare swell: float
    declare cut: float
    declare restart: 0 | 1
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumRimDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, ratio: box.ratio, balance: box.balance, high: box.high, highRatio: box.highRatio,
            ring: box.ring, ringHigh: box.ringHigh, decay: box.decay, punch: box.punch, drive: box.drive,
            hard: box.hard, click: box.click, swell: box.swell, cut: box.cut, restart: box.restart,
            volume: box.volume, velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumHatImpl extends InstrumentFacade<OpenDrumHatDeviceBox> implements OpenDrumHat {
    readonly key = "OpenDrumHat" as const
    declare tune: float
    declare color: float
    declare hold: float
    declare decay: float
    declare spread: bipolar
    declare ring: unitValue
    declare reso: unitValue
    declare curve: bipolar
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumHatDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, color: box.color, hold: box.hold, decay: box.decay, spread: box.spread, ring: box.ring,
            reso: box.reso, curve: box.curve, volume: box.volume, velocity: box.velocity, play: box.play,
            panning: box.panning
        })
    }
}

export class OpenDrumShakerImpl extends InstrumentFacade<OpenDrumShakerDeviceBox> implements OpenDrumShaker {
    readonly key = "OpenDrumShaker" as const
    declare color: float
    declare attack: float
    declare decay: float
    declare curve: bipolar
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumShakerDeviceBox) {
        super(context, box)
        this.bind({
            color: box.color, attack: box.attack, decay: box.decay, curve: box.curve, volume: box.volume,
            velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumCymbalImpl extends InstrumentFacade<OpenDrumCymbalDeviceBox> implements OpenDrumCymbal {
    readonly key = "OpenDrumCymbal" as const
    declare tune: float
    declare tone: unitValue
    declare attack: float
    declare decay: float
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumCymbalDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, tone: box.tone, attack: box.attack, decay: box.decay, volume: box.volume,
            velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumBellImpl extends InstrumentFacade<OpenDrumBellDeviceBox> implements OpenDrumBell {
    readonly key = "OpenDrumBell" as const
    declare tune: float
    declare ratio: float
    declare balance: unitValue
    declare color: float
    declare strike: unitValue
    declare decay: float
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumBellDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, ratio: box.ratio, balance: box.balance, color: box.color, strike: box.strike,
            decay: box.decay, volume: box.volume, velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export class OpenDrumPercImpl extends InstrumentFacade<OpenDrumPercDeviceBox> implements OpenDrumPerc {
    readonly key = "OpenDrumPerc" as const
    declare tune: float
    declare ratio: float
    declare index: unitValue
    declare bite: float
    declare pitch: float
    declare sweep: float
    declare decay: float
    declare curve: bipolar
    declare noise: unitValue
    declare drive: float
    declare volume: float
    declare velocity: unitValue
    declare play: 0 | 1 | 2
    declare panning: bipolar

    constructor(context: Context, box: OpenDrumPercDeviceBox) {
        super(context, box)
        this.bind({
            tune: box.tune, ratio: box.ratio, index: box.index, bite: box.bite, pitch: box.pitch, sweep: box.sweep,
            decay: box.decay, curve: box.curve, noise: box.noise, drive: box.drive, volume: box.volume,
            velocity: box.velocity, play: box.play, panning: box.panning
        })
    }
}

export namespace InstrumentImpls {
    export const wrap = (context: Context, box: Box): AnyInstrumentImpl => context.facade(box, () => {
        if (box instanceof VaporisateurDeviceBox) {return new VaporisateurImpl(context, box)}
        if (box instanceof PlayfieldDeviceBox) {return new PlayfieldImpl(context, box)}
        if (box instanceof NanoDeviceBox) {return new NanoImpl(context, box)}
        if (box instanceof SamplerDeviceBox) {return new SamplerImpl(context, box)}
        if (box instanceof SoundfontDeviceBox) {return new SoundfontImpl(context, box)}
        if (box instanceof MIDIOutputDeviceBox) {return new MIDIOutputImpl(context, box)}
        if (box instanceof TapeDeviceBox) {return new TapeImpl(context, box)}
        if (box instanceof NeonDeviceBox) {return new NeonImpl(context, box)}
        if (box instanceof TubularDeviceBox) {return new TubularImpl(context, box)}
        if (box instanceof SurgeonDeviceBox) {return new SurgeonImpl(context, box)}
        if (box instanceof OpenDrumKickDeviceBox) {return new OpenDrumKickImpl(context, box)}
        if (box instanceof OpenDrumSnareDeviceBox) {return new OpenDrumSnareImpl(context, box)}
        if (box instanceof OpenDrumClapDeviceBox) {return new OpenDrumClapImpl(context, box)}
        if (box instanceof OpenDrumTomDeviceBox) {return new OpenDrumTomImpl(context, box)}
        if (box instanceof OpenDrumRimDeviceBox) {return new OpenDrumRimImpl(context, box)}
        if (box instanceof OpenDrumHatDeviceBox) {return new OpenDrumHatImpl(context, box)}
        if (box instanceof OpenDrumShakerDeviceBox) {return new OpenDrumShakerImpl(context, box)}
        if (box instanceof OpenDrumCymbalDeviceBox) {return new OpenDrumCymbalImpl(context, box)}
        if (box instanceof OpenDrumBellDeviceBox) {return new OpenDrumBellImpl(context, box)}
        if (box instanceof OpenDrumPercDeviceBox) {return new OpenDrumPercImpl(context, box)}
        if (box instanceof CubedDeviceBox) {return new CubedImpl(context, box)}
        if (box instanceof ApparatDeviceBox) {return new ApparatImpl(context, box)}
        if (box instanceof InstrumentCompositeBox) {return new InstrumentCompositeImpl(context, box)}
        return panic(`${box.name} is not a supported instrument`)
    }) as AnyInstrumentImpl

    export const isBox = (box: Box): box is InstrumentDeviceBox => DeviceBoxes.isInstrumentBox(box.name)

}
