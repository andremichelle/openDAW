import {
    GrooveFunctionBox,
    GrooveOffsetBox,
    GrooveRandomBox,
    GrooveShuffleBox,
    GrooveStackBox
} from "@opendaw/studio-boxes"
import {Box, PointerField} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {Pointers} from "@opendaw/studio-enums"
import {Grooves, isGrooveBox} from "@opendaw/studio-adapters"
import {int, isAbsent, Nullable, panic, unitValue} from "@opendaw/lib-std"
import {AnyGroove, GrooveFunction, GrooveOffset, GrooveRandom, GrooveShuffle, GrooveStack} from "../Api"
import {Context} from "./Context"
import {Facade} from "./Common"

export class GrooveShuffleImpl extends Facade<GrooveShuffleBox> implements GrooveShuffle {
    static wrap(context: Context, box: GrooveShuffleBox): GrooveShuffleImpl {
        return context.facade(box, () => new GrooveShuffleImpl(context, box))
    }

    readonly kind = "Shuffle" as const

    declare label: string
    declare amount: unitValue
    declare duration: ppqn

    private constructor(context: Context, box: GrooveShuffleBox) {
        super(context, box)
        this.bind({label: box.label, amount: box.amount, duration: box.duration})
    }
}

export class GrooveFunctionImpl extends Facade<GrooveFunctionBox> implements GrooveFunction {
    static wrap(context: Context, box: GrooveFunctionBox): GrooveFunctionImpl {
        return context.facade(box, () => new GrooveFunctionImpl(context, box))
    }

    declare label: string
    declare amount: unitValue
    declare duration: ppqn

    private constructor(context: Context, box: GrooveFunctionBox) {
        super(context, box)
        this.bind({label: box.label, amount: box.amount, duration: box.duration})
    }

    get kind(): "Power" | "S-Curve" {return this.box.function.getValue() === 1 ? "S-Curve" : "Power"}
}

export class GrooveRandomImpl extends Facade<GrooveRandomBox> implements GrooveRandom {
    static wrap(context: Context, box: GrooveRandomBox): GrooveRandomImpl {
        return context.facade(box, () => new GrooveRandomImpl(context, box))
    }

    readonly kind = "Random" as const

    declare label: string
    declare amount: unitValue
    declare duration: ppqn
    declare seed: int
    declare roughness: unitValue
    declare steps: int

    private constructor(context: Context, box: GrooveRandomBox) {
        super(context, box)
        this.bind({
            label: box.label, amount: box.amount, duration: box.duration,
            seed: box.seed, roughness: box.roughness, steps: box.steps
        })
    }
}

export class GrooveOffsetImpl extends Facade<GrooveOffsetBox> implements GrooveOffset {
    static wrap(context: Context, box: GrooveOffsetBox): GrooveOffsetImpl {
        return context.facade(box, () => new GrooveOffsetImpl(context, box))
    }

    readonly kind = "Offset" as const

    declare label: string
    declare offset: int

    private constructor(context: Context, box: GrooveOffsetBox) {
        super(context, box)
        this.bind({label: box.label, offset: box.offset})
    }
}

export class GrooveStackImpl extends Facade<GrooveStackBox> implements GrooveStack {
    static wrap(context: Context, box: GrooveStackBox): GrooveStackImpl {
        return context.facade(box, () => new GrooveStackImpl(context, box))
    }

    readonly kind = "Stack" as const

    declare label: string

    private constructor(context: Context, box: GrooveStackBox) {
        super(context, box)
        this.bind({label: box.label})
    }

    get members(): ReadonlyArray<AnyGroove> {
        return Grooves.entriesOf(this.box)
            .flatMap(entry => entry.groove.targetVertex.match({
                none: () => [],
                some: vertex => [GrooveImpls.wrap(this.context, vertex.box)]
            }))
    }
}

export namespace GrooveImpls {
    export const isBox = isGrooveBox

    // The groove a pointer targets, null for none
    export const read = (context: Context, pointer: PointerField<Pointers.Groove>): Nullable<AnyGroove> =>
        pointer.targetVertex.mapOr(vertex => wrap(context, vertex.box), null)

    // Points at a groove of the project, or at none
    export const write = (context: Context, pointer: PointerField<Pointers.Groove>, groove: Nullable<AnyGroove>): void => {
        if (isAbsent(groove)) {
            context.edit(() => pointer.defer())
            return
        }
        if (!(groove instanceof Facade) || !isBox(groove.box)
            || groove.box.graph !== pointer.box.graph || !groove.box.isAttached()) {
            return panic("Expected a groove of the project")
        }
        const box = groove.box
        context.edit(() => pointer.refer(box))
    }

    export const wrap = (context: Context, box: Box): AnyGroove => {
        if (box instanceof GrooveShuffleBox) {return GrooveShuffleImpl.wrap(context, box)}
        if (box instanceof GrooveFunctionBox) {return GrooveFunctionImpl.wrap(context, box)}
        if (box instanceof GrooveRandomBox) {return GrooveRandomImpl.wrap(context, box)}
        if (box instanceof GrooveOffsetBox) {return GrooveOffsetImpl.wrap(context, box)}
        if (box instanceof GrooveStackBox) {return GrooveStackImpl.wrap(context, box)}
        return panic(`${box.name} is not a groove`)
    }
}
