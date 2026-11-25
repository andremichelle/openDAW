import {NoteEventBox, NoteEventCollectionBox, NoteEventGroupBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {InterpolationFieldAdapter, NoteEventFeatures} from "@opendaw/studio-adapters"
import {asInstanceOf, bipolar, float, int, isDefined, Nullable, panic, unitValue, UUID} from "@opendaw/lib-std"
import {NoteEvent, NoteEventProps, NoteGroup, NoteGroupMode, ValueEvent, ValueEventProps} from "../../Api"
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

    private constructor(context: Context, box: NoteEventBox) {
        super(context, box)
        this.bind({position: box.position, duration: box.duration, pitch: box.pitch, velocity: box.velocity, cents: box.cent})
    }

    get playCount(): int {return NoteEventFeatures.readPlayCount(this.box)}
    set playCount(value: int) {
        const validated = Guard.int32({min: 1, max: 128}, value, "playCount")
        this.context.edit(() => NoteEventFeatures.writePlayCount(this.box, validated))
    }
    get playCurve(): bipolar {return NoteEventFeatures.readPlayCurve(this.box)}
    set playCurve(value: bipolar) {
        const validated = Guard.float32("bipolar", value, "playCurve")
        this.context.edit(() => NoteEventFeatures.writePlayCurve(this.box, validated))
    }
    get repeatLength(): unitValue {return NoteEventFeatures.readRepeatLength(this.box)}
    set repeatLength(value: unitValue) {
        const validated = Guard.float32("unipolar", value, "repeatLength")
        this.context.edit(() => NoteEventFeatures.writeRepeatLength(this.box, validated))
    }
    get velocityFade(): bipolar {return NoteEventFeatures.readVelocityFade(this.box)}
    set velocityFade(value: bipolar) {
        const validated = Guard.float32("bipolar", value, "velocityFade")
        this.context.edit(() => NoteEventFeatures.writeVelocityFade(this.box, validated))
    }
    get chance(): int {return NoteEventFeatures.readChance(this.box)}
    set chance(value: int) {
        const validated = Guard.int32({min: 0, max: 100}, value, "chance")
        this.context.edit(() => NoteEventFeatures.writeChance(this.box, validated))
    }
    get group(): Nullable<NoteGroupImpl> {
        return NoteEventFeatures.groupBox(this.box).mapOr(box => NoteGroupImpl.wrap(this.context, box), null)
    }
    leaveGroup(): void {this.context.edit(() => NoteEventFeatures.leaveGroup([this.box]))}
}

export class NoteGroupImpl extends Facade<NoteEventGroupBox> implements NoteGroup {
    static wrap(context: Context, box: NoteEventGroupBox): NoteGroupImpl {
        return context.facade(box, () => new NoteGroupImpl(context, box))
    }

    declare chance: int

    private constructor(context: Context, box: NoteEventGroupBox) {
        super(context, box)
        this.bind({chance: box.chance})
    }

    get mode(): NoteGroupMode {
        return this.box.mode.getValue() === NoteEventFeatures.GroupMode.PlayOne ? "play-one" : "play-all"
    }
    set mode(value: NoteGroupMode) {
        const validated = NoteGroupModes.validate(value)
        this.context.edit(() => this.box.mode.setValue(validated))
    }
    get events(): ReadonlyArray<NoteEventImpl> {
        return this.box.pointerHub.incoming()
            .map(({box}) => NoteEventImpl.wrap(this.context, asInstanceOf(box, NoteEventBox)))
            .sort((first, second) => first.position - second.position || first.pitch - second.pitch)
    }
    ungroup(): void {this.context.edit(() => this.box.delete())}
}

export namespace NoteGroupModes {
    export const validate = (value: unknown, name: string = "mode"): NoteEventFeatures.GroupMode => {
        if (value === "play-all") {return NoteEventFeatures.GroupMode.PlayAll}
        if (value === "play-one") {return NoteEventFeatures.GroupMode.PlayOne}
        return panic(new TypeError(`${name}: expected "play-all" or "play-one", got ${Guard.describe(value)}`))
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

    group(events: ReadonlyArray<NoteEvent>, mode: NoteGroupMode = "play-all"): NoteGroupImpl {
        if (!Array.isArray(events)) {return panic(new TypeError("groupEvents: expected an array"))}
        const validated = NoteGroupModes.validate(mode)
        const members = this.list()
        const boxes = events.map((event, index) => {
            const member = members.find(candidate => candidate === event)
            return isDefined(member) ? member.box : panic(new RangeError(`groupEvents: event ${index} is not a note of this owner`))
        })
        if (boxes.length === 0) {return panic(new RangeError("groupEvents: expected at least one note"))}
        return this.#context.edit(() => NoteGroupImpl.wrap(this.#context,
            NoteEventFeatures.group(boxes, validated).unwrap("group")))
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
