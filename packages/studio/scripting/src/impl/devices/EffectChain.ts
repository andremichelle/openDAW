import {BooleanField, Box, Field, IndexedBox, Int32Field, PointerField, PointerTypes, StringField} from "@opendaw/lib-box"
import {clamp, Func, int, isDefined, Optional} from "@opendaw/lib-std"
import {Context} from "../Context"
import {Facade, Props} from "../Common"

export type EffectDeviceBox = Box & {
    readonly host: PointerField<PointerTypes>
    readonly index: Int32Field<PointerTypes>
    readonly label: StringField<PointerTypes>
    readonly enabled: BooleanField<PointerTypes>
    readonly minimized: BooleanField<PointerTypes>
}

export abstract class EffectFacade<B extends EffectDeviceBox = EffectDeviceBox> extends Facade<B> {
    declare label: string
    declare enabled: boolean
    declare minimized: boolean

    protected constructor(context: Context, box: B) {
        super(context, box)
        this.bind({label: box.label, enabled: box.enabled, minimized: box.minimized})
    }

    get index(): int {return this.box.index.getValue()}
    get hostField(): Field {return this.box.host.targetVertex.unwrap("effect has no host") as Field}

    move(index: int): void {
        this.context.edit(() => {
            const boxes = IndexedBox.collectIndexedBoxes(this.hostField).filter(box => box !== this.box)
            const at = clamp(Math.round(index), 0, boxes.length)
            const ordered = [...boxes.slice(0, at), this.box, ...boxes.slice(at)]
            ordered.forEach((box, index) => box.index.setValue(index))
        })
    }

    remove(): void {
        this.context.edit(() => {
            const field = this.hostField
            const index = this.index
            IndexedBox.removeOrder(field, index)
            this.box.delete()
        })
    }
}

export class EffectChain<F extends EffectFacade> {
    readonly #context: Context
    readonly #field: Field
    readonly #wrap: Func<Box, F>

    constructor(context: Context, field: Field, wrap: Func<Box, F>) {
        this.#context = context
        this.#field = field
        this.#wrap = wrap
    }

    list(): ReadonlyArray<F> {
        return IndexedBox.collectIndexedBoxes(this.#field).map(box => this.#wrap(box))
    }

    add(create: Func<int, Box>, props: unknown, index: Optional<int>): F {
        return this.#context.edit(() => {
            const at = IndexedBox.insertOrder(this.#field, isDefined(index) ? Math.round(index) : Number.MAX_SAFE_INTEGER)
            const facade = this.#wrap(create(at))
            Props.apply(facade, props)
            return facade
        })
    }
}
