import {
    ArpeggioDeviceBox,
    NoteFilterDeviceBox,
    PitchDeviceBox,
    SpielwerkDeviceBox,
    VelocityDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {bipolar, float, int, Nullable, panic, unitValue} from "@opendaw/lib-std"
import {
    AnyAudioUnit,
    AnyGroove,
    ArpeggioEffect,
    ArpeggioStep,
    MIDIEffects,
    NoteFilterEffect,
    PitchEffect,
    ScriptParameter,
    ScriptSample,
    SpielwerkEffect,
    VelocityEffect,
    ZeitgeistEffect
} from "../../Api"
import {Context} from "../Context"
import {EffectDeviceBox, EffectFacade} from "./EffectChain"
import {Facades} from "../Facades"
import {GrooveImpls} from "../Grooves"
import {ScriptSupport} from "./ScriptDevices"
import {MIDIEffectBox} from "./DeviceBoxes"

export abstract class MIDIEffectFacade<B extends EffectDeviceBox = EffectDeviceBox> extends EffectFacade<B> {
    abstract readonly key: keyof MIDIEffects
    get audioUnit(): AnyAudioUnit {return Facades.audioUnitOf(this.context, this.box)}
}

export type AnyMIDIEffectImpl = ArpeggioEffectImpl | PitchEffectImpl | NoteFilterEffectImpl | VelocityEffectImpl
    | ZeitgeistEffectImpl | SpielwerkEffectImpl

export class ArpeggioEffectImpl extends MIDIEffectFacade<ArpeggioDeviceBox> implements ArpeggioEffect {
    readonly key = "Arpeggio" as const
    declare mode: int
    declare octaves: int
    declare rate: int
    declare gate: float
    declare repeat: int
    declare velocity: bipolar
    declare order: int
    declare hold: boolean
    declare retrigger: int
    declare offset: int
    declare followChords: boolean
    declare seed: int
    declare patternLength: int
    declare readonly steps: ReadonlyArray<ArpeggioStep>

    constructor(context: Context, box: ArpeggioDeviceBox) {
        super(context, box)
        this.bind({
            mode: box.modeIndex, octaves: box.numOctaves, rate: box.rateIndex,
            gate: box.gate, repeat: box.repeat, velocity: box.velocity,
            order: box.order, hold: box.hold, retrigger: box.retrigger, offset: box.offset, followChords: box.followChords,
            seed: box.seed, patternLength: box.patternLength,
            steps: box.stepKinds.fields().map((kind, index) => ({
                kind, velocity: box.stepVelocities.getField(index), gate: box.stepGates.getField(index),
                transpose: box.stepTransposes.getField(index), octave: box.stepOctaves.getField(index),
                chance: box.stepChances.getField(index), ratchet: box.stepRatchets.getField(index)
            }))
        })
    }
}

export class PitchEffectImpl extends MIDIEffectFacade<PitchDeviceBox> implements PitchEffect {
    readonly key = "Pitch" as const
    declare octaves: int
    declare semiTones: int
    declare cents: float

    constructor(context: Context, box: PitchDeviceBox) {
        super(context, box)
        this.bind({octaves: box.octaves, semiTones: box.semiTones, cents: box.cents})
    }
}

export class NoteFilterEffectImpl extends MIDIEffectFacade<NoteFilterDeviceBox> implements NoteFilterEffect {
    readonly key = "NoteFilter" as const
    declare min: int
    declare max: int
    declare set: boolean
    declare transpose: int
    declare targetKey: int

    constructor(context: Context, box: NoteFilterDeviceBox) {
        super(context, box)
        this.bind({min: box.min, max: box.max, set: box.set, transpose: box.transpose, targetKey: box.key})
    }
}

export class VelocityEffectImpl extends MIDIEffectFacade<VelocityDeviceBox> implements VelocityEffect {
    readonly key = "Velocity" as const
    declare magnetPosition: unitValue
    declare magnetStrength: unitValue
    declare randomSeed: int
    declare randomAmount: unitValue
    declare offset: bipolar
    declare mix: unitValue

    constructor(context: Context, box: VelocityDeviceBox) {
        super(context, box)
        this.bind({
            magnetPosition: box.magnetPosition, magnetStrength: box.magnetStrength, randomSeed: box.randomSeed,
            randomAmount: box.randomAmount, offset: box.offset, mix: box.mix
        })
    }
}

export class ZeitgeistEffectImpl extends MIDIEffectFacade<ZeitgeistDeviceBox> implements ZeitgeistEffect {
    readonly key = "Zeitgeist" as const

    constructor(context: Context, box: ZeitgeistDeviceBox) {super(context, box)}

    get groove(): Nullable<AnyGroove> {
        return this.box.groove.targetVertex.mapOr(vertex => GrooveImpls.wrap(this.context, vertex.box), null)
    }
}

export class SpielwerkEffectImpl extends MIDIEffectFacade<SpielwerkDeviceBox> implements SpielwerkEffect {
    readonly key = "Spielwerk" as const
    readonly #script: ScriptSupport

    constructor(context: Context, box: SpielwerkDeviceBox) {
        super(context, box)
        this.#script = new ScriptSupport(context, box, "spielwerk")
    }

    get code(): string {return this.#script.code}
    set code(source: string) {this.#script.code = source}
    get parameters(): ReadonlyArray<ScriptParameter> {return this.#script.parameters}
    get samples(): ReadonlyArray<ScriptSample> {return this.#script.samples}
    parameter(label: string): ScriptParameter {return this.#script.parameter(label)}
    sample(label: string): ScriptSample {return this.#script.sample(label)}
}

export namespace MIDIEffectImpls {
    export const wrap = (context: Context, box: Box): AnyMIDIEffectImpl => context.facade(box, () => {
        if (box instanceof ArpeggioDeviceBox) {return new ArpeggioEffectImpl(context, box)}
        if (box instanceof PitchDeviceBox) {return new PitchEffectImpl(context, box)}
        if (box instanceof NoteFilterDeviceBox) {return new NoteFilterEffectImpl(context, box)}
        if (box instanceof VelocityDeviceBox) {return new VelocityEffectImpl(context, box)}
        if (box instanceof ZeitgeistDeviceBox) {return new ZeitgeistEffectImpl(context, box)}
        if (box instanceof SpielwerkDeviceBox) {return new SpielwerkEffectImpl(context, box)}
        return panic(`${box.name} is not a supported midi-effect`)
    }) as AnyMIDIEffectImpl

    export const isBox = (box: Box): box is MIDIEffectBox =>
        box instanceof ArpeggioDeviceBox || box instanceof PitchDeviceBox || box instanceof VelocityDeviceBox
        || box instanceof NoteFilterDeviceBox || box instanceof ZeitgeistDeviceBox || box instanceof SpielwerkDeviceBox
}
