import {TimelineBox, ValueEventBox, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {Interpolation, ppqn} from "@opendaw/lib-dsp"
import {InterpolationFieldAdapter, TempoRange} from "@opendaw/studio-adapters"
import {asInstanceOf, clamp, int, UUID} from "@opendaw/lib-std"
import {TempoEvent, TempoEventProps, TempoTrack} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Fields} from "../Fields"
import {Guard} from "../Guard"
import {Interpolations} from "./Events"

export class TempoEventImpl extends Facade<ValueEventBox> implements TempoEvent {
    static wrap(context: Context, box: ValueEventBox): TempoEventImpl {
        return context.facade(box, () => new TempoEventImpl(context, box))
    }

    declare position: ppqn

    private constructor(context: Context, box: ValueEventBox) {
        super(context, box)
        this.bind({position: box.position})
    }

    get bpm(): number {return this.box.value.getValue()}
    set bpm(value: number) {
        const validated = clamp(Guard.finite(value, "bpm"), TempoRange.min, TempoRange.max)
        this.context.edit(() => this.box.value.setValue(validated))
    }

    get interpolation(): Interpolation {return InterpolationFieldAdapter.read(this.box.interpolation)}
    set interpolation(value: Interpolation) {
        const validated = Interpolations.validate(value)
        this.context.edit(() => InterpolationFieldAdapter.write(this.box.interpolation, validated))
    }
}

export class TempoTrackImpl implements TempoTrack {
    readonly #context: Context
    readonly #timelineBox: TimelineBox

    declare enabled: boolean
    declare minBpm: int
    declare maxBpm: int

    constructor(context: Context, timelineBox: TimelineBox) {
        this.#context = context
        this.#timelineBox = timelineBox
        const {tempoTrack} = timelineBox
        Fields.bind(context, this, {enabled: tempoTrack.enabled, minBpm: tempoTrack.minBpm, maxBpm: tempoTrack.maxBpm}, "tempoTrack.")
    }

    get events(): ReadonlyArray<TempoEvent> {
        return this.#collection().events.pointerHub.incoming()
            .map(({box}) => TempoEventImpl.wrap(this.#context, asInstanceOf(box, ValueEventBox)))
            .sort((a, b) => a.position - b.position)
    }

    addEvent(props?: TempoEventProps): TempoEvent {
        return this.#context.edit(() => {
            const collection = this.#collection()
            const position = Guard.int32("any", props?.position ?? 0, "position")
            if (this.events.some(event => event.position === position)) {
                return panicSamePosition(position)
            }
            const box = ValueEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.events.refer(collection.events)
                box.position.setValue(position)
                box.index.setValue(0)
                box.value.setValue(this.#timelineBox.bpm.getValue())
                box.slope.setValue(NaN)
            })
            const rest = Props.without(props, "position")
            return Props.apply(TempoEventImpl.wrap(this.#context, box), rest)
        })
    }

    clearEvents(): void {this.#context.edit(() => this.events.forEach(event => event.remove()))}

    #collection(): ValueEventCollectionBox {
        const {tempoTrack} = this.#timelineBox
        return tempoTrack.events.targetVertex
            .map(vertex => asInstanceOf(vertex.box, ValueEventCollectionBox))
            .unwrapOrElse(() => this.#context.edit(() =>
                ValueEventCollectionBox.create(this.#context.boxGraph, UUID.generate(), box => tempoTrack.events.refer(box.owners))))
    }
}

const panicSamePosition = (position: ppqn): never => {
    throw new RangeError(`position: a tempo event already exists at ${position}`)
}
