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
    PlayfieldDeviceBox,
    PlayfieldSampleBox,
    SoundfontDeviceBox,
    SoundfontFileBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {BooleanField, Box, IndexedBox, Int32Field, PointerField, PointerTypes, StringField} from "@opendaw/lib-box"
import {ClassicWaveform} from "@opendaw/lib-dsp"
import {VoicingMode} from "@opendaw/studio-enums"
import {CubedStep as CubedStepCodec, InstrumentFactories} from "@opendaw/studio-adapters"
import {asInstanceOf, bipolar, clamp, float, int, isDefined, isNull, Nullable, panic, unitValue, UUID} from "@opendaw/lib-std"
import {
    AnyAudioEffect,
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
    Tubular,
    TubularLfo,
    TubularOperator,
    TubularPitchEnvelope,
    Playfield,
    PlayfieldSlot,
    Sample,
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
import {Fields, FieldSpec} from "../Fields"
import {Guard} from "../Guard"
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
    | VaporisateurImpl | PlayfieldImpl | NanoImpl | SoundfontImpl | MIDIOutputImpl | TapeImpl | NeonImpl | TubularImpl | CubedImpl
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

export class PlayfieldSlotImpl extends Facade<PlayfieldSampleBox> implements PlayfieldSlot {
    static wrap(context: Context, box: PlayfieldSampleBox): PlayfieldSlotImpl {
        return context.facade(box, () => new PlayfieldSlotImpl(context, box))
    }

    declare note: int
    declare icon: string
    declare enabled: boolean
    declare minimized: boolean
    declare mute: boolean
    declare solo: boolean
    declare exclude: boolean
    declare polyphone: boolean
    declare gate: 0 | 1 | 2
    declare pitch: float
    declare sampleStart: unitValue
    declare sampleEnd: unitValue
    declare attack: float
    declare release: float
    declare volume: float
    declare panning: bipolar
    readonly #midiChain: EffectChain<AnyMIDIEffectImpl>
    readonly #audioChain: EffectChain<AnyAudioEffectImpl>

    private constructor(context: Context, box: PlayfieldSampleBox) {
        super(context, box)
        this.bind({
            note: box.index, icon: box.icon, enabled: box.enabled, minimized: box.minimized, mute: box.mute,
            solo: box.solo, exclude: box.exclude, polyphone: box.polyphone, gate: box.gate, pitch: box.pitch,
            sampleStart: box.sampleStart, sampleEnd: box.sampleEnd, attack: box.attack, release: box.release,
            volume: box.volume, panning: box.panning
        })
        this.#midiChain = new EffectChain<AnyMIDIEffectImpl>(context, box.midiEffects, box => MIDIEffectImpls.wrap(context, box))
        this.#audioChain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    get playfield(): Playfield {
        const deviceBox = this.box.device.targetVertex.unwrap("slot has no playfield").box
        return InstrumentImpls.wrap(this.context, deviceBox) as PlayfieldImpl
    }
    get sample(): Sample {
        return AudioFiles.toSample(this.context, asInstanceOf(this.box.file.targetVertex.unwrap("slot has no file").box, AudioFileBox))
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

export class PlayfieldImpl extends InstrumentFacade<PlayfieldDeviceBox> implements Playfield {
    readonly key = "Playfield" as const

    constructor(context: Context, box: PlayfieldDeviceBox) {super(context, box)}

    get slots(): ReadonlyArray<PlayfieldSlot> {
        return this.box.samples.pointerHub.incoming()
            .map(({box}) => PlayfieldSlotImpl.wrap(this.context, asInstanceOf(box, PlayfieldSampleBox)))
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
            this.slot(note)?.remove()
            const slotBox = PlayfieldSampleBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.device.refer(this.box.samples)
                box.file.refer(fileBox)
                box.index.setValue(note)
            })
            const rest = Props.without(props, "note")
            return Props.apply(PlayfieldSlotImpl.wrap(this.context, slotBox), rest)
        })
    }

    #nextFreeNote(): int {
        const taken = new Set(this.slots.map(slot => slot.note))
        for (let note = 60; note < 128; note++) {if (!taken.has(note)) {return note}}
        for (let note = 59; note >= 0; note--) {if (!taken.has(note)) {return note}}
        return panic("All 128 notes are taken")
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
        return context.facade(box, () => new InstrumentCompositeLayerImpl(context, box))
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
        return InstrumentImpls.wrap(this.context, deviceBox) as InstrumentCompositeImpl
    }
    get instrument(): LayerInstruments[keyof LayerInstruments] {
        const instrumentBox = this.box.instrument.pointerHub.incoming().at(0)?.box ?? panic("Layer has no instrument")
        return InstrumentImpls.wrap(this.context, instrumentBox) as unknown as LayerInstruments[keyof LayerInstruments]
    }
    get midiEffects(): ReadonlyArray<AnyMIDIEffect> {return this.#midiChain.list()}
    get audioEffects(): ReadonlyArray<AnyAudioEffect> {return this.#audioChain.list()}

    setInstrument<K extends keyof LayerInstruments>(key: K, props?: DeepPartial<LayerInstruments[K]>): LayerInstruments[K] {
        const guarded = guardLayerInstrument(key)
        return this.context.edit(() => {
            const label = this.box.instrument.pointerHub.incoming().at(0)?.box
            const previousLabel = isDefined(label) && InstrumentImpls.isBox(label) ? label.label.getValue() : undefined
            this.box.instrument.pointerHub.incoming().forEach(({box}) => box.delete())
            const instrumentBox = DeviceBoxes.createInstrument(this.context.boxGraph, guarded, this.box.instrument,
                previousLabel ?? InstrumentFactories.Named[guarded].defaultName)
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
            const instrumentBox = DeviceBoxes.createInstrument(this.context.boxGraph, guarded, cellBox.instrument,
                InstrumentFactories.Named[guarded].defaultName)
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

    constructor(context: Context, box: NanoDeviceBox) {
        super(context, box)
        this.bind({
            volume: box.volume, octave: box.octave, tune: box.tune, rootKey: box.rootKey, attack: box.attack, release: box.release,
            sampleStart: box.sampleStart, sampleEnd: box.sampleEnd, loop: box.loop, loopFade: box.loopFade,
            loopStart: box.loopStart, loopEnd: box.loopEnd
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

export namespace InstrumentImpls {
    export const wrap = (context: Context, box: Box): AnyInstrumentImpl => context.facade(box, () => {
        if (box instanceof VaporisateurDeviceBox) {return new VaporisateurImpl(context, box)}
        if (box instanceof PlayfieldDeviceBox) {return new PlayfieldImpl(context, box)}
        if (box instanceof NanoDeviceBox) {return new NanoImpl(context, box)}
        if (box instanceof SoundfontDeviceBox) {return new SoundfontImpl(context, box)}
        if (box instanceof MIDIOutputDeviceBox) {return new MIDIOutputImpl(context, box)}
        if (box instanceof TapeDeviceBox) {return new TapeImpl(context, box)}
        if (box instanceof NeonDeviceBox) {return new NeonImpl(context, box)}
        if (box instanceof TubularDeviceBox) {return new TubularImpl(context, box)}
        if (box instanceof CubedDeviceBox) {return new CubedImpl(context, box)}
        if (box instanceof ApparatDeviceBox) {return new ApparatImpl(context, box)}
        if (box instanceof InstrumentCompositeBox) {return new InstrumentCompositeImpl(context, box)}
        return panic(`${box.name} is not a supported instrument`)
    }) as AnyInstrumentImpl

    export const isBox = (box: Box): box is InstrumentDeviceBox => DeviceBoxes.isInstrumentBox(box.name)

}
