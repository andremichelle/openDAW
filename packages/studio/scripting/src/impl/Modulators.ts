import {
    LfoModulatorBox,
    MacroModulatorBox,
    ModulationBox,
    RandomModulatorBox,
    StepsModulatorBox
} from "@opendaw/studio-boxes"
import {
    BooleanField,
    Box,
    Field,
    Float32Field,
    IndexedBox,
    Int32Field,
    PointerField,
    PointerTypes,
    PrimitiveField,
    StringField
} from "@opendaw/lib-box"
import {asInstanceOf, bipolar, clamp, float, int, isNull, panic, Strings, unitValue, UUID} from "@opendaw/lib-std"
import {
    AnyModulator,
    Automatable,
    DeepPartial,
    LfoModulator,
    MacroModulator,
    Modulation,
    Modulator,
    Modulators as ModulatorTypes,
    ParameterPath,
    RandomModulator,
    StepsModulator,
    Track,
    ValueTrack
} from "../Api"
import {Context} from "./Context"
import {Facade, Parameters, Props} from "./Common"
import {Guard} from "./Guard"
import {Facades} from "./Facades"
import {AudioUnitImpls} from "./AudioUnits"
import {TrackImpls, ValueTrackImpl} from "./timeline/Tracks"
import {TrackType} from "@opendaw/studio-adapters"

export type ModulatorBox = LfoModulatorBox | StepsModulatorBox | MacroModulatorBox | RandomModulatorBox

type ModulatorFields = Box & {
    readonly collection: PointerField<PointerTypes>
    readonly assignments: Field<PointerTypes>
    readonly tracks: Field<PointerTypes>
    readonly label: StringField<PointerTypes>
    readonly enabled: BooleanField<PointerTypes>
    readonly index: Int32Field<PointerTypes>
    readonly bipolar: BooleanField<PointerTypes>
    readonly amount: Float32Field<PointerTypes>
}

export class ModulationImpl extends Facade<ModulationBox> implements Modulation {
    static wrap(context: Context, box: ModulationBox): ModulationImpl {
        return context.facade(box, () => new ModulationImpl(context, box))
    }

    declare depth: bipolar
    declare enabled: boolean

    private constructor(context: Context, box: ModulationBox) {
        super(context, box)
        this.bind({depth: box.depth, enabled: box.enabled})
    }

    get source(): AnyModulator {
        const field = this.box.source.targetVertex.unwrap("modulation has no source")
        return ModulatorImpls.wrap(this.context, field.box as ModulatorBox)
    }
    get targetField(): Field {return this.box.target.targetVertex.unwrap("modulation has no target") as Field}
    get target(): Automatable {
        const facade = Facades.forBox(this.context, this.targetField.box)
        if (isNull(facade)) {return panic(`No object found for modulation target ${this.targetField.toString()}`)}
        return facade as Automatable
    }
    get parameter(): string {
        const field = this.targetField
        if (!(field instanceof PrimitiveField)) {return panic("modulation target is not a parameter")}
        return Parameters.pathOf(this.target, field) ?? panic(`Unknown parameter path for ${field.toString()}`)
    }
}

export abstract class ModulatorFacade<B extends ModulatorFields> extends Facade<B> implements Modulator {
    abstract readonly kind: keyof ModulatorTypes
    declare label: string
    declare enabled: boolean
    declare bipolar: boolean
    declare amount: unitValue

    protected constructor(context: Context, box: B) {
        super(context, box)
        this.bind({label: box.label, enabled: box.enabled, bipolar: box.bipolar, amount: box.amount})
    }

    get index(): int {return this.box.index.getValue()}

    get modulations(): ReadonlyArray<Modulation> {
        return IndexedBox.collectIndexedBoxes(this.box.assignments)
            .map(box => ModulationImpl.wrap(this.context, asInstanceOf(box, ModulationBox)))
    }

    get valueTracks(): ReadonlyArray<ValueTrack> {
        return TrackImpls.list(this.context, this.box.tracks)
            .filter((track): track is ValueTrackImpl => track instanceof ValueTrackImpl)
    }

    addValueTrack<T extends AnyModulator | Modulation>(target: T, parameter: ParameterPath<T>, props?: Partial<Pick<Track, "enabled">>): ValueTrack {
        const field = AudioUnitImpls.automationField(target, parameter)
        const ownerBox = field.box instanceof ModulationBox
            ? field.box.source.targetVertex.unwrap("modulation has no source").box
            : field.box
        if (ownerBox !== this.box) {return panic(new RangeError(`'${parameter}' does not belong to this modulator`))}
        if (this.valueTracks.some(track => (track as ValueTrackImpl).box.target.targetVertex.contains(field))) {
            return panic(new RangeError(`'${parameter}' is already automated by a track`))
        }
        return Props.apply(TrackImpls.create(this.context, this.box.tracks, TrackType.Value, field, null), props) as ValueTrack
    }

    assign<T extends Automatable>(target: T, parameter: ParameterPath<T>, depth: bipolar = 0.25): Modulation {
        const field = AudioUnitImpls.modulationField(target, parameter)
        const validatedDepth = Guard.float32("bipolar", depth, "depth")
        return this.context.edit(() => {
            const box = ModulationBox.create(this.context.boxGraph, UUID.generate(), box => {
                box.source.refer(this.box.assignments)
                box.target.refer(field)
                box.index.setValue(this.box.assignments.pointerHub.incoming().length)
                box.depth.setValue(validatedDepth)
            })
            return ModulationImpl.wrap(this.context, box)
        })
    }

    remove(): void {
        this.context.edit(() => {
            const rootBox = this.context.skeleton.mandatoryBoxes.rootBox
            const index = this.index
            IndexedBox.removeOrder(rootBox.modulators, index)
            this.box.delete()
        })
    }
}

export class LfoModulatorImpl extends ModulatorFacade<LfoModulatorBox> implements LfoModulator {
    readonly kind = "LFO" as const
    declare shape: 0 | 1 | 2 | 3 | 4
    declare rateSync: int
    declare rateAbsolute: float
    declare phase: unitValue
    declare exponent: bipolar

    constructor(context: Context, box: LfoModulatorBox) {
        super(context, box)
        this.bind({shape: box.shape, rateSync: box.rateSync, rateAbsolute: box.rateAbsolute, phase: box.phase, exponent: box.exponent})
    }
}

export class StepsModulatorImpl extends ModulatorFacade<StepsModulatorBox> implements StepsModulator {
    readonly kind = "Steps" as const
    declare count: int
    declare rateSync: int
    declare rateAbsolute: float
    declare phase: unitValue
    declare smooth: unitValue
    declare direction: 0 | 1 | 2 | 3 | 4
    declare readonly steps: ReadonlyArray<unitValue>

    constructor(context: Context, box: StepsModulatorBox) {
        super(context, box)
        this.bind({
            count: box.count, rateSync: box.rateSync, rateAbsolute: box.rateAbsolute, phase: box.phase,
            smooth: box.smooth, direction: box.direction, steps: box.steps.fields()
        })
    }

    setSteps(values: ReadonlyArray<unitValue>): void {
        if (!Array.isArray(values)) {return panic(new TypeError("setSteps: expected an array"))}
        const fields = this.box.steps.fields()
        if (values.length > fields.length) {return panic(new RangeError(`setSteps: at most ${fields.length} steps`))}
        this.context.edit(() => {
            values.forEach((value, index) => fields[index].setValue(Guard.float32("unipolar", value, `steps.${index}`)))
            this.box.count.setValue(clamp(values.length, 1, fields.length))
        })
    }
}

export class MacroModulatorImpl extends ModulatorFacade<MacroModulatorBox> implements MacroModulator {
    readonly kind = "Macro" as const
    declare value: unitValue

    constructor(context: Context, box: MacroModulatorBox) {
        super(context, box)
        this.bind({value: box.value})
    }
}

export class RandomModulatorImpl extends ModulatorFacade<RandomModulatorBox> implements RandomModulator {
    readonly kind = "Random" as const
    declare loop: int
    declare rateSync: int
    declare rateAbsolute: float
    declare phase: unitValue
    declare smooth: unitValue
    declare seed: int
    declare levels: int

    constructor(context: Context, box: RandomModulatorBox) {
        super(context, box)
        this.bind({
            loop: box.loop, rateSync: box.rateSync, rateAbsolute: box.rateAbsolute, phase: box.phase,
            smooth: box.smooth, seed: box.seed, levels: box.levels
        })
    }
}

export type AnyModulatorImpl = LfoModulatorImpl | StepsModulatorImpl | MacroModulatorImpl | RandomModulatorImpl

export namespace ModulatorImpls {
    export const Kinds: ReadonlyArray<keyof ModulatorTypes> = ["LFO", "Steps", "Macro", "Random"]

    export const wrap = (context: Context, box: Box): AnyModulatorImpl => context.facade(box, () => {
        if (box instanceof LfoModulatorBox) {return new LfoModulatorImpl(context, box)}
        if (box instanceof StepsModulatorBox) {return new StepsModulatorImpl(context, box)}
        if (box instanceof MacroModulatorBox) {return new MacroModulatorImpl(context, box)}
        if (box instanceof RandomModulatorBox) {return new RandomModulatorImpl(context, box)}
        return panic(`${box.name} is not a modulator`)
    }) as AnyModulatorImpl

    export const list = (context: Context): ReadonlyArray<AnyModulatorImpl> =>
        IndexedBox.collectIndexedBoxes(context.skeleton.mandatoryBoxes.rootBox.modulators)
            .map(box => wrap(context, box))

    export const create = <K extends keyof ModulatorTypes>(context: Context, kind: K, props?: DeepPartial<ModulatorTypes[K]>): ModulatorTypes[K] => {
        Guard.oneOf(kind, Kinds, "kind")
        return context.edit(() => {
            const {boxGraph, mandatoryBoxes: {rootBox}} = context.skeleton
            const existing = list(context)
            const label = Strings.getUniqueName(existing.map(modulator => modulator.label), kind)
            const attach = (box: ModulatorFields) => {
                box.collection.refer(rootBox.modulators)
                box.index.setValue(existing.length)
                box.label.setValue(label)
            }
            const box: ModulatorBox = kind === "LFO"
                ? LfoModulatorBox.create(boxGraph, UUID.generate(), attach)
                : kind === "Steps"
                    ? StepsModulatorBox.create(boxGraph, UUID.generate(), attach)
                    : kind === "Macro"
                        ? MacroModulatorBox.create(boxGraph, UUID.generate(), attach)
                        : RandomModulatorBox.create(boxGraph, UUID.generate(), attach)
            return Props.apply(wrap(context, box), props) as unknown as ModulatorTypes[K]
        })
    }
}
