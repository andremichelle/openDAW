import {
    GrooveFunctionBox,
    GrooveRandomBox,
    GrooveShuffleBox,
    GrooveStackBox,
    GrooveStackEntryBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {int, isInstanceOf, panic, unitValue} from "@opendaw/lib-std"
import {AnyGroove, GrooveFunction, GrooveRandom, GrooveShuffle, GrooveStack} from "../Api"
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
        return this.box.entries.pointerHub.incoming()
            .map(pointer => pointer.box)
            .filter((box): box is GrooveStackEntryBox => isInstanceOf(box, GrooveStackEntryBox))
            .sort((left, right) => left.index.getValue() - right.index.getValue())
            .flatMap(entry => entry.groove.targetVertex.match({
                none: () => [],
                some: vertex => [GrooveImpls.wrap(this.context, vertex.box)]
            }))
    }
}

export namespace GrooveImpls {
    export const isBox = (box: Box): boolean => box instanceof GrooveShuffleBox || box instanceof GrooveFunctionBox
        || box instanceof GrooveRandomBox || box instanceof GrooveStackBox

    export const wrap = (context: Context, box: Box): AnyGroove => {
        if (box instanceof GrooveShuffleBox) {return GrooveShuffleImpl.wrap(context, box)}
        if (box instanceof GrooveFunctionBox) {return GrooveFunctionImpl.wrap(context, box)}
        if (box instanceof GrooveRandomBox) {return GrooveRandomImpl.wrap(context, box)}
        if (box instanceof GrooveStackBox) {return GrooveStackImpl.wrap(context, box)}
        return panic(`${box.name} is not a groove`)
    }
}
