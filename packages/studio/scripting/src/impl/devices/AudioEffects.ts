import {
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    AudioFileBox,
    AutotuneDeviceBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    FrequencySplitBox,
    GateDeviceBox,
    MaximizerDeviceBox,
    NeuralAmpDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoCompositeBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    VocoderDeviceBox,
    WaveshaperDeviceBox,
    WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import {Box, Field, IndexedBox, PointerField} from "@opendaw/lib-box"
import {Mixing} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {asInstanceOf, bipolar, float, int, isNull, Nullable, panic, unitValue} from "@opendaw/lib-std"
import {
    AnyAudioEffect,
    AnyAudioUnit,
    AudioEffectCompositeEffect,
    AudioEffectCompositeEntry,
    AudioEffects,
    AutotuneEffect,
    CompressorEffect,
    ConvolverEffect,
    CrusherEffect,
    DattorroReverbEffect,
    DeepPartial,
    DelayEffect,
    FoldEffect,
    FrequencySplitEffect,
    GateEffect,
    MaximizerEffect,
    NeuralAmpEffect,
    RevampBell,
    RevampEffect,
    RevampPass,
    RevampShelf,
    ReverbEffect,
    Sample,
    ScriptParameter,
    ScriptSample,
    SideChainSource,
    StereoSplitEffect,
    StereoToolEffect,
    TidalEffect,
    VocoderEffect,
    WaveshaperEffect,
    WerkstattEffect
} from "../../Api"
import {Context} from "../Context"
import {Accessors, Facade, Props} from "../Common"
import {EffectChain, EffectDeviceBox, EffectFacade} from "./EffectChain"
import {Facades} from "../Facades"
import {ScriptSupport} from "./ScriptDevices"
import {AudioFiles} from "../AudioFiles"
import {AudioEffectBox, DeviceBoxes} from "./DeviceBoxes"
import {Guard} from "../Guard"

export abstract class AudioEffectFacade<B extends EffectDeviceBox = EffectDeviceBox> extends EffectFacade<B> {
    abstract readonly key: keyof AudioEffects
    get audioUnit(): AnyAudioUnit {return Facades.audioUnitOf(this.context, this.box)}
}

export namespace SideChains {
    export const read = (context: Context, pointer: PointerField): Nullable<SideChainSource> =>
        pointer.targetVertex.mapOr(vertex => Facades.forVertex(context, vertex) as SideChainSource, null)

    export const write = (context: Context, owner: Box, pointer: PointerField, source: Nullable<SideChainSource>): void =>
        context.edit(() => {
            if (isNull(source)) {
                pointer.defer()
                return
            }
            const box = Facades.boxOf(source)
            if (Facades.isCompositeBox(box) && Facades.isNestedIn(owner, box)) {
                pointer.refer(Facades.compositeInputField(box))
            } else {
                pointer.refer(box)
            }
        })
}

type SideChainBox = EffectDeviceBox & { readonly sideChain: PointerField<Pointers.SideChain> }

export abstract class SideChainableEffect<B extends SideChainBox> extends AudioEffectFacade<B> {
    get sideChain(): Nullable<SideChainSource> {return SideChains.read(this.context, this.box.sideChain)}
    set sideChain(source: Nullable<SideChainSource>) {SideChains.write(this.context, this.box, this.box.sideChain, source)}
}

export type AnyAudioEffectImpl =
    | AutotuneEffectImpl | CompressorEffectImpl | ConvolverEffectImpl | CrusherEffectImpl | DattorroReverbEffectImpl
    | DelayEffectImpl | FoldEffectImpl | GateEffectImpl | MaximizerEffectImpl | NeuralAmpEffectImpl | RevampEffectImpl
    | ReverbEffectImpl | StereoToolEffectImpl | TidalEffectImpl | VocoderEffectImpl | WaveshaperEffectImpl
    | WerkstattEffectImpl | AudioEffectCompositeImpl | StereoSplitEffectImpl | FrequencySplitEffectImpl

export class AutotuneEffectImpl extends AudioEffectFacade<AutotuneDeviceBox> implements AutotuneEffect {
    readonly key = "Autotune" as const
    declare scaleKey: int
    declare scale: int
    declare amount: unitValue
    declare retune: unitValue
    declare shift: float
    declare smooth: unitValue

    constructor(context: Context, box: AutotuneDeviceBox) {
        super(context, box)
        this.bind({
            scaleKey: box.key, scale: box.scale, amount: box.amount, retune: box.retune,
            shift: box.shift, smooth: box.smooth
        })
    }
}

export class CompressorEffectImpl extends SideChainableEffect<CompressorDeviceBox> implements CompressorEffect {
    readonly key = "Compressor" as const
    declare lookahead: boolean
    declare automakeup: boolean
    declare autoattack: boolean
    declare autorelease: boolean
    declare inputGain: float
    declare threshold: float
    declare ratio: float
    declare knee: float
    declare attack: float
    declare release: float
    declare makeup: float
    declare mix: unitValue

    constructor(context: Context, box: CompressorDeviceBox) {
        super(context, box)
        this.bind({
            lookahead: box.lookahead, automakeup: box.automakeup, autoattack: box.autoattack,
            autorelease: box.autorelease, inputGain: box.inputgain, threshold: box.threshold, ratio: box.ratio,
            knee: box.knee, attack: box.attack, release: box.release, makeup: box.makeup, mix: box.mix
        })
    }
}

export class ConvolverEffectImpl extends AudioEffectFacade<ConvolverDeviceBox> implements ConvolverEffect {
    readonly key = "Convolver" as const
    declare wet: float
    declare dry: float
    declare preDelay: float
    declare normalize: boolean
    declare reverse: boolean

    constructor(context: Context, box: ConvolverDeviceBox) {
        super(context, box)
        this.bind({wet: box.wet, dry: box.dry, preDelay: box.preDelay, normalize: box.normalize, reverse: box.reverse})
    }

    get impulse(): Nullable<Sample> {
        const fileBox = Accessors.pointerBox(this.box.file, AudioFileBox)
        return isNull(fileBox) ? null : AudioFiles.toSample(this.context, fileBox)
    }
    set impulse(sample: Nullable<Sample>) {
        AudioFiles.assign(this.context, this.box.file, () => isNull(sample) ? null : AudioFiles.use(this.context, sample))
    }
}

export class CrusherEffectImpl extends AudioEffectFacade<CrusherDeviceBox> implements CrusherEffect {
    readonly key = "Crusher" as const
    declare crush: unitValue
    declare bits: int
    declare boost: float
    declare mix: float

    constructor(context: Context, box: CrusherDeviceBox) {
        super(context, box)
        this.bind({crush: box.crush, bits: box.bits, boost: box.boost, mix: box.mix})
    }
}

export class DattorroReverbEffectImpl extends AudioEffectFacade<DattorroReverbDeviceBox> implements DattorroReverbEffect {
    readonly key = "DattorroReverb" as const
    declare preDelay: float
    declare bandwidth: unitValue
    declare inputDiffusion1: unitValue
    declare inputDiffusion2: unitValue
    declare decay: unitValue
    declare decayDiffusion1: unitValue
    declare decayDiffusion2: unitValue
    declare damping: unitValue
    declare excursionRate: unitValue
    declare excursionDepth: unitValue
    declare wet: float
    declare dry: float

    constructor(context: Context, box: DattorroReverbDeviceBox) {
        super(context, box)
        this.bind({
            preDelay: box.preDelay, bandwidth: box.bandwidth, inputDiffusion1: box.inputDiffusion1,
            inputDiffusion2: box.inputDiffusion2, decay: box.decay, decayDiffusion1: box.decayDiffusion1,
            decayDiffusion2: box.decayDiffusion2, damping: box.damping, excursionRate: box.excursionRate,
            excursionDepth: box.excursionDepth, wet: box.wet, dry: box.dry
        })
    }
}

export class DelayEffectImpl extends AudioEffectFacade<DelayDeviceBox> implements DelayEffect {
    readonly key = "Delay" as const
    declare delay: int
    declare delayMillis: float
    declare preSyncTimeLeft: int
    declare preMillisTimeLeft: float
    declare preSyncTimeRight: int
    declare preMillisTimeRight: float
    declare feedback: unitValue
    declare cross: unitValue
    declare lfoSpeed: float
    declare lfoDepth: float
    declare filter: bipolar
    declare wet: float
    declare dry: float

    constructor(context: Context, box: DelayDeviceBox) {
        super(context, box)
        this.bind({
            delay: box.delayMusical, delayMillis: box.delayMillis, preSyncTimeLeft: box.preSyncTimeLeft,
            preMillisTimeLeft: box.preMillisTimeLeft, preSyncTimeRight: box.preSyncTimeRight,
            preMillisTimeRight: box.preMillisTimeRight, feedback: box.feedback, cross: box.cross,
            lfoSpeed: box.lfoSpeed, lfoDepth: box.lfoDepth, filter: box.filter, wet: box.wet, dry: box.dry
        })
    }
}

export class FoldEffectImpl extends AudioEffectFacade<FoldDeviceBox> implements FoldEffect {
    readonly key = "Fold" as const
    declare drive: float
    declare overSampling: 0 | 1 | 2
    declare volume: float

    constructor(context: Context, box: FoldDeviceBox) {
        super(context, box)
        this.bind({drive: box.drive, overSampling: box.overSampling, volume: box.volume})
    }
}

export class GateEffectImpl extends SideChainableEffect<GateDeviceBox> implements GateEffect {
    readonly key = "Gate" as const
    declare threshold: float
    declare return: float
    declare attack: float
    declare hold: float
    declare release: float
    declare floor: float
    declare inverse: boolean

    constructor(context: Context, box: GateDeviceBox) {
        super(context, box)
        this.bind({
            threshold: box.threshold, return: box.return, attack: box.attack, hold: box.hold,
            release: box.release, floor: box.floor, inverse: box.inverse
        })
    }
}

export class MaximizerEffectImpl extends AudioEffectFacade<MaximizerDeviceBox> implements MaximizerEffect {
    readonly key = "Maximizer" as const
    declare lookahead: boolean
    declare threshold: float

    constructor(context: Context, box: MaximizerDeviceBox) {
        super(context, box)
        this.bind({lookahead: box.lookahead, threshold: box.threshold})
    }
}

export class NeuralAmpEffectImpl extends AudioEffectFacade<NeuralAmpDeviceBox> implements NeuralAmpEffect {
    readonly key = "NeuralAmp" as const
    declare inputGain: float
    declare outputGain: float
    declare mono: boolean
    declare mix: unitValue

    constructor(context: Context, box: NeuralAmpDeviceBox) {
        super(context, box)
        this.bind({inputGain: box.inputGain, outputGain: box.outputGain, mono: box.mono, mix: box.mix})
    }
}

export class RevampEffectImpl extends AudioEffectFacade<RevampDeviceBox> implements RevampEffect {
    readonly key = "Revamp" as const
    declare readonly highPass: RevampPass
    declare readonly lowShelf: RevampShelf
    declare readonly lowBell: RevampBell
    declare readonly midBell: RevampBell
    declare readonly highBell: RevampBell
    declare readonly highShelf: RevampShelf
    declare readonly lowPass: RevampPass

    constructor(context: Context, box: RevampDeviceBox) {
        super(context, box)
        const pass = (field: RevampDeviceBox["highPass"]) =>
            ({enabled: field.enabled, frequency: field.frequency, order: field.order, q: field.q})
        const shelf = (field: RevampDeviceBox["lowShelf"]) =>
            ({enabled: field.enabled, frequency: field.frequency, gain: field.gain})
        const bell = (field: RevampDeviceBox["lowBell"]) =>
            ({enabled: field.enabled, frequency: field.frequency, gain: field.gain, q: field.q})
        this.bind({
            highPass: pass(box.highPass), lowShelf: shelf(box.lowShelf), lowBell: bell(box.lowBell),
            midBell: bell(box.midBell), highBell: bell(box.highBell), highShelf: shelf(box.highShelf),
            lowPass: pass(box.lowPass)
        })
    }
}

export class ReverbEffectImpl extends AudioEffectFacade<ReverbDeviceBox> implements ReverbEffect {
    readonly key = "Reverb" as const
    declare decay: unitValue
    declare preDelay: float
    declare damp: unitValue
    declare filter: bipolar
    declare wet: float
    declare dry: float

    constructor(context: Context, box: ReverbDeviceBox) {
        super(context, box)
        this.bind({decay: box.decay, preDelay: box.preDelay, damp: box.damp, filter: box.filter, wet: box.wet, dry: box.dry})
    }
}

export class StereoToolEffectImpl extends AudioEffectFacade<StereoToolDeviceBox> implements StereoToolEffect {
    readonly key = "StereoTool" as const
    declare volume: float
    declare panning: bipolar
    declare stereo: bipolar
    declare invertL: boolean
    declare invertR: boolean
    declare swap: boolean
    declare panningMixing: Mixing

    constructor(context: Context, box: StereoToolDeviceBox) {
        super(context, box)
        this.bind({
            volume: box.volume, panning: box.panning, stereo: box.stereo, invertL: box.invertL,
            invertR: box.invertR, swap: box.swap, panningMixing: box.panningMixing
        })
    }
}

export class TidalEffectImpl extends AudioEffectFacade<TidalDeviceBox> implements TidalEffect {
    readonly key = "Tidal" as const
    declare slope: bipolar
    declare symmetry: unitValue
    declare rate: float
    declare depth: unitValue
    declare offset: float
    declare channelOffset: float

    constructor(context: Context, box: TidalDeviceBox) {
        super(context, box)
        this.bind({
            slope: box.slope, symmetry: box.symmetry, rate: box.rate, depth: box.depth,
            offset: box.offset, channelOffset: box.channelOffset
        })
    }
}

export class VocoderEffectImpl extends SideChainableEffect<VocoderDeviceBox> implements VocoderEffect {
    readonly key = "Vocoder" as const
    declare carrierMinFreq: float
    declare carrierMaxFreq: float
    declare modulatorMinFreq: float
    declare modulatorMaxFreq: float
    declare qStart: float
    declare qEnd: float
    declare envAttack: float
    declare envRelease: float
    declare gain: float
    declare mix: unitValue
    declare bandCount: 8 | 12 | 16

    constructor(context: Context, box: VocoderDeviceBox) {
        super(context, box)
        this.bind({
            carrierMinFreq: box.carrierMinFreq, carrierMaxFreq: box.carrierMaxFreq,
            modulatorMinFreq: box.modulatorMinFreq, modulatorMaxFreq: box.modulatorMaxFreq,
            qStart: box.qStart, qEnd: box.qEnd, envAttack: box.envAttack, envRelease: box.envRelease,
            gain: box.gain, mix: box.mix, bandCount: box.bandCount
        })
    }

    get modulatorSource(): "noise-pink" | "noise-white" | "input" {
        return this.box.modulatorSource.getValue() as "noise-pink" | "noise-white" | "input"
    }
    set modulatorSource(value: "noise-pink" | "noise-white" | "input") {
        const validated = Guard.oneOf(value, ["noise-pink", "noise-white", "input"], "modulatorSource")
        this.context.edit(() => this.box.modulatorSource.setValue(validated))
    }
}

export class WaveshaperEffectImpl extends AudioEffectFacade<WaveshaperDeviceBox> implements WaveshaperEffect {
    readonly key = "Waveshaper" as const
    declare equation: string
    declare inputGain: float
    declare outputGain: float
    declare mix: unitValue

    constructor(context: Context, box: WaveshaperDeviceBox) {
        super(context, box)
        this.bind({equation: box.equation, inputGain: box.inputGain, outputGain: box.outputGain, mix: box.mix})
    }
}

export class WerkstattEffectImpl extends AudioEffectFacade<WerkstattDeviceBox> implements WerkstattEffect {
    readonly key = "Werkstatt" as const
    readonly #script: ScriptSupport

    constructor(context: Context, box: WerkstattDeviceBox) {
        super(context, box)
        this.#script = new ScriptSupport(context, box, "werkstatt")
    }

    get code(): string {return this.#script.code}
    set code(source: string) {this.#script.code = source}
    get parameters(): ReadonlyArray<ScriptParameter> {return this.#script.parameters}
    get samples(): ReadonlyArray<ScriptSample> {return this.#script.samples}
    parameter(label: string): ScriptParameter {return this.#script.parameter(label)}
    sample(label: string): ScriptSample {return this.#script.sample(label)}
}

// ---- Composites

export type CompositeBox = AudioEffectCompositeBox | StereoCompositeBox | FrequencySplitBox

export class AudioEffectCompositeEntryImpl extends Facade<AudioEffectCompositeCellBox> implements AudioEffectCompositeEntry {
    static wrap(context: Context, box: AudioEffectCompositeCellBox): AudioEffectCompositeEntryImpl {
        return context.facade(box, () => new AudioEffectCompositeEntryImpl(context, box))
    }

    declare label: string
    declare gain: float
    declare mute: boolean
    declare solo: boolean
    declare pan: bipolar
    readonly #chain: EffectChain<AnyAudioEffectImpl>

    private constructor(context: Context, box: AudioEffectCompositeCellBox) {
        super(context, box)
        this.bind({label: box.label, gain: box.gain, mute: box.mute, solo: box.solo, pan: box.pan})
        this.#chain = new EffectChain<AnyAudioEffectImpl>(context, box.audioEffects, box => AudioEffectImpls.wrap(context, box))
    }

    get index(): int {return this.box.index.getValue()}
    get composite(): AudioEffectCompositeEffect | StereoSplitEffect | FrequencySplitEffect {
        const compositeBox = this.box.composite.targetVertex.unwrap("entry has no composite").box
        return AudioEffectImpls.wrap(this.context, compositeBox) as AudioEffectCompositeImpl | StereoSplitEffectImpl | FrequencySplitEffectImpl
    }
    get audioEffects(): ReadonlyArray<AnyAudioEffect> {return this.#chain.list()}

    addAudioEffect<K extends keyof AudioEffects>(key: K, props?: DeepPartial<AudioEffects[K]>, index?: int): AudioEffects[K] {
        Guard.oneOf(key, Object.keys(DeviceBoxes.AudioEffectLabels), "key")
        return this.#chain.add(at => DeviceBoxes.createAudioEffect(this.context.boxGraph, key, this.box.audioEffects, at),
            props, index) as unknown as AudioEffects[K]
    }

    remove(): void {
        const compositeBox = this.box.composite.targetVertex.unwrap("entry has no composite").box
        if (!(compositeBox instanceof AudioEffectCompositeBox)) {
            return panic(`Entries of ${compositeBox.name} are fixed and cannot be removed`)
        }
        this.context.edit(() => {
            const index = this.index
            IndexedBox.removeOrder(compositeBox.entries, index)
            this.box.delete()
        })
    }
}

const listEntries = (context: Context, field: Field): ReadonlyArray<AudioEffectCompositeEntryImpl> =>
    IndexedBox.collectIndexedBoxes(field)
        .map(box => AudioEffectCompositeEntryImpl.wrap(context, asInstanceOf(box, AudioEffectCompositeCellBox)))

export class AudioEffectCompositeImpl extends AudioEffectFacade<AudioEffectCompositeBox> implements AudioEffectCompositeEffect {
    readonly key = "Composite" as const
    declare dry: float
    declare wet: float

    constructor(context: Context, box: AudioEffectCompositeBox) {
        super(context, box)
        this.bind({dry: box.dry, wet: box.wet})
    }

    get entries(): ReadonlyArray<AudioEffectCompositeEntry> {return listEntries(this.context, this.box.entries)}

    addEntry(props?: Partial<Pick<AudioEffectCompositeEntry, "label" | "gain" | "mute" | "solo" | "pan">>): AudioEffectCompositeEntry {
        return this.context.edit(() => {
            const index = this.box.entries.pointerHub.incoming().length
            const box = DeviceBoxes.createCompositeEntry(this.context.boxGraph, this.box.entries, index, `Entry ${index + 1}`)
            return Props.apply(AudioEffectCompositeEntryImpl.wrap(this.context, box), props)
        })
    }
}

export class StereoSplitEffectImpl extends AudioEffectFacade<StereoCompositeBox> implements StereoSplitEffect {
    readonly key = "StereoSplit" as const
    declare dry: float
    declare wet: float

    constructor(context: Context, box: StereoCompositeBox) {
        super(context, box)
        this.bind({dry: box.dry, wet: box.wet})
    }

    get entries(): ReadonlyArray<AudioEffectCompositeEntry> {return listEntries(this.context, this.box.entries)}
}

export class FrequencySplitEffectImpl extends AudioEffectFacade<FrequencySplitBox> implements FrequencySplitEffect {
    readonly key = "FrequencySplit" as const
    declare dry: float
    declare wet: float
    declare crossover1: float
    declare crossover2: float
    declare crossover3: float

    constructor(context: Context, box: FrequencySplitBox) {
        super(context, box)
        this.bind({dry: box.dry, wet: box.wet, crossover1: box.crossover1, crossover2: box.crossover2, crossover3: box.crossover3})
    }

    get entries(): ReadonlyArray<AudioEffectCompositeEntry> {return listEntries(this.context, this.box.entries)}
}

export namespace AudioEffectImpls {
    export const wrap = (context: Context, box: Box): AnyAudioEffectImpl => context.facade(box, () => {
        if (box instanceof AutotuneDeviceBox) {return new AutotuneEffectImpl(context, box)}
        if (box instanceof CompressorDeviceBox) {return new CompressorEffectImpl(context, box)}
        if (box instanceof ConvolverDeviceBox) {return new ConvolverEffectImpl(context, box)}
        if (box instanceof CrusherDeviceBox) {return new CrusherEffectImpl(context, box)}
        if (box instanceof DattorroReverbDeviceBox) {return new DattorroReverbEffectImpl(context, box)}
        if (box instanceof DelayDeviceBox) {return new DelayEffectImpl(context, box)}
        if (box instanceof FoldDeviceBox) {return new FoldEffectImpl(context, box)}
        if (box instanceof GateDeviceBox) {return new GateEffectImpl(context, box)}
        if (box instanceof MaximizerDeviceBox) {return new MaximizerEffectImpl(context, box)}
        if (box instanceof NeuralAmpDeviceBox) {return new NeuralAmpEffectImpl(context, box)}
        if (box instanceof RevampDeviceBox) {return new RevampEffectImpl(context, box)}
        if (box instanceof ReverbDeviceBox) {return new ReverbEffectImpl(context, box)}
        if (box instanceof StereoToolDeviceBox) {return new StereoToolEffectImpl(context, box)}
        if (box instanceof TidalDeviceBox) {return new TidalEffectImpl(context, box)}
        if (box instanceof VocoderDeviceBox) {return new VocoderEffectImpl(context, box)}
        if (box instanceof WaveshaperDeviceBox) {return new WaveshaperEffectImpl(context, box)}
        if (box instanceof WerkstattDeviceBox) {return new WerkstattEffectImpl(context, box)}
        if (box instanceof AudioEffectCompositeBox) {return new AudioEffectCompositeImpl(context, box)}
        if (box instanceof StereoCompositeBox) {return new StereoSplitEffectImpl(context, box)}
        if (box instanceof FrequencySplitBox) {return new FrequencySplitEffectImpl(context, box)}
        return panic(`${box.name} is not a supported audio-effect`)
    }) as AnyAudioEffectImpl

    export const isBox = (box: Box): box is AudioEffectBox => DeviceBoxes.isAudioEffectBox(box.name)

    export const isCompositeBox = (box: Box): box is CompositeBox =>
        box instanceof AudioEffectCompositeBox || box instanceof StereoCompositeBox || box instanceof FrequencySplitBox
}
