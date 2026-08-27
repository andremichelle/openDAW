import {NoteEventBox, NoteEventCollectionBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {InterpolationFieldAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, bipolar, float, int, isDefined, panic, unitValue, UUID} from "@opendaw/lib-std"
import {NoteEvent, NoteEventProps, ValueEvent, ValueEventProps} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Guard} from "../Guard"

export class NoteEventImpl extends Facade<NoteEventBox> implements NoteEvent {
    static wrap(context: Context, box: NoteEventBox): NoteEventImpl {
        return context.facade(box, () => new NoteEventImpl(context, box))
    }

    declare position: ppqn
    declare duration: ppqn
    declare pitch: int
    declare velocity: unitValue
    declare cents: float
    declare playCount: int
    declare playCurve: bipolar
    declare chance: int

    private constructor(context: Context, box: NoteEventBox) {
        super(context, box)
        this.bind({
            position: box.position, duration: box.duration, pitch: box.pitch, velocity: box.velocity,
            cents: box.cent, playCount: box.playCount, playCurve: box.playCurve, chance: box.chance
        })
    }
}

export class ValueEventImpl extends Facade<ValueEventBox> implements ValueEvent {
    static wrap(context: Context, box: ValueEventBox): ValueEventImpl {
        return context.facade(box, () => new ValueEventImpl(context, box))
    }

    declare position: ppqn
    declare value: unitValue

    private constructor(context: Context, box: ValueEventBox) {
        super(context, box)
        this.bind({position: box.position, value: box.value})
    }

    get index(): int {return this.box.index.getValue()}

    get interpolation(): Interpolation {return InterpolationFieldAdapter.read(this.box.interpolation)}
    set interpolation(value: Interpolation) {
        const validated = Interpolations.validate(value)
        this.context.edit(() => InterpolationFieldAdapter.write(this.box.interpolation, validated))
    }
}

export namespace Interpolations {
    export const validate = (value: unknown, name: string = "interpolation"): Interpolation => {
        if (!isDefined(value) || typeof value !== "object") {
            return panic(new TypeError(`${name}: expected Interpolation.None, Interpolation.Linear or Interpolation.Curve(slope)`))
        }
        const {type, slope} = value as { type?: unknown, slope?: unknown }
        if (type === "none") {return Interpolation.None}
        if (type === "linear") {return Interpolation.Linear}
        if (type === "curve") {return Interpolation.Curve(Guard.float32("unipolar", slope, `${name}.slope`))}
        return panic(new TypeError(`${name}: unknown interpolation type ${Guard.describe(type)}`))
    }
}

export class NoteEvents {
    readonly #context: Context
    readonly #collection: NoteEventCollectionBox

    constructor(context: Context, collection: NoteEventCollectionBox) {
        this.#context = context
        this.#collection = collection
    }

    get collection(): NoteEventCollectionBox {return this.#collection}

    list(): ReadonlyArray<NoteEventImpl> {
        return this.#collection.events.pointerHub.incoming()
            .map(({box}) => NoteEventImpl.wrap(this.#context, asInstanceOf(box, NoteEventBox)))
            .sort((a, b) => a.position - b.position || a.pitch - b.pitch)
    }

    add(props?: NoteEventProps): NoteEventImpl {
        return this.#context.edit(() => {
            const box = NoteEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.events.refer(this.#collection.events)
            })
            return Props.apply(NoteEventImpl.wrap(this.#context, box), props, "event")
        })
    }

    addAll(events: ReadonlyArray<NoteEventProps>): ReadonlyArray<NoteEventImpl> {
        if (!Array.isArray(events)) {return panic(new TypeError("addEvents: expected an array"))}
        return this.#context.edit(() => events.map(props => this.add(props)))
    }

    clear(): void {this.#context.edit(() => this.list().forEach(event => event.box.delete()))}
}

export class ValueEvents {
    readonly #context: Context
    readonly #collection: ValueEventCollectionBox

    constructor(context: Context, collection: ValueEventCollectionBox) {
        this.#context = context
        this.#collection = collection
    }

    get collection(): ValueEventCollectionBox {return this.#collection}

    list(): ReadonlyArray<ValueEventImpl> {
        return this.#collection.events.pointerHub.incoming()
            .map(({box}) => ValueEventImpl.wrap(this.#context, asInstanceOf(box, ValueEventBox)))
            .sort((a, b) => a.position - b.position || a.index - b.index)
    }

    add(props?: ValueEventProps): ValueEventImpl {
        return this.#context.edit(() => {
            const position = Guard.integer(props?.position ?? 0, "event.position")
            const sharing = this.list().filter(event => event.position === position)
            if (sharing.length >= 2) {
                return panic(new RangeError(`event.position: at most two events can share position ${position}`))
            }
            const box = ValueEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.events.refer(this.#collection.events)
                box.position.setValue(position)
                box.index.setValue(sharing.length)
                box.slope.setValue(NaN)
            })
            const event = ValueEventImpl.wrap(this.#context, box)
            const rest = Props.without(props, "position")
            return Props.apply(event, rest, "event")
        })
    }

    addAll(events: ReadonlyArray<ValueEventProps>): ReadonlyArray<ValueEventImpl> {
        if (!Array.isArray(events)) {return panic(new TypeError("addEvents: expected an array"))}
        return this.#context.edit(() => events.map(props => this.add(props)))
    }

    clear(): void {this.#context.edit(() => this.list().forEach(event => event.box.delete()))}
}
