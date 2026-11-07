import {ChordEventBox, TimelineBox} from "@opendaw/studio-boxes"
import {Harmony, PPQN, ppqn} from "@opendaw/lib-dsp"
import {asInstanceOf, int, isDefined, Nullable, UUID} from "@opendaw/lib-std"
import {ChordEvent, ChordEventProps, ChordTrack, ResolvedChord} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Fields} from "../Fields"
import {Guard} from "../Guard"
import {KeyTrackImpl} from "./KeyTrackImpl"

export class ChordEventImpl extends Facade<ChordEventBox> implements ChordEvent {
    static wrap(context: Context, box: ChordEventBox): ChordEventImpl {
        return context.facade(box, () => new ChordEventImpl(context, box))
    }

    declare position: ppqn
    declare duration: ppqn
    declare degree: int
    declare shift: int
    declare shape: int
    declare notes: int
    declare inversion: int

    private constructor(context: Context, box: ChordEventBox) {
        super(context, box)
        this.bind({
            position: box.position, duration: box.duration, degree: box.degree, shift: box.shift,
            shape: box.shape, notes: box.notes, inversion: box.inversion
        })
    }

    get complete(): ppqn {return this.position + this.duration}
}

export class ChordTrackImpl implements ChordTrack {
    readonly #context: Context
    readonly #timelineBox: TimelineBox
    readonly #keyTrack: KeyTrackImpl

    declare enabled: boolean

    constructor(context: Context, timelineBox: TimelineBox, keyTrack: KeyTrackImpl) {
        this.#context = context
        this.#timelineBox = timelineBox
        this.#keyTrack = keyTrack
        Fields.bind(context, this, {enabled: timelineBox.chordTrack.enabled}, "chordTrack.")
    }

    get events(): ReadonlyArray<ChordEventImpl> {
        return this.#timelineBox.chordTrack.events.pointerHub.incoming()
            .map(({box}) => ChordEventImpl.wrap(this.#context, asInstanceOf(box, ChordEventBox)))
            .sort((a, b) => a.position - b.position)
    }

    chordAt(position: ppqn): Nullable<ResolvedChord> {
        const validated = Guard.finite(position, "position")
        if (!this.enabled) {return null}
        const event = this.events.findLast(event => event.position <= validated)
        if (!isDefined(event) || validated >= event.complete) {return null}
        const {root, scale} = this.#keyTrack.keyAt(event.position)
        return Harmony.chord({root, bits: scale}, event.degree, event.shift, event.shape, event.notes, event.inversion)
            .mapOr(chord => Object.freeze({
                root: chord.root, notes: Object.freeze([...chord.voicing]), name: Harmony.chordName(chord)
            }), null)
    }

    addEvent(props?: ChordEventProps): ChordEvent {
        return this.#context.edit(() => {
            const position = Guard.int32("non-negative", props?.position ?? 0, "position")
            const duration = Guard.int32("positive", props?.duration ?? PPQN.Bar, "duration")
            const box = ChordEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.track.refer(this.#timelineBox.chordTrack.events)
                box.position.setValue(position)
                box.duration.setValue(duration)
                box.degree.setValue(1)
            })
            const added = Props.apply(ChordEventImpl.wrap(this.#context, box), Props.without(props, "position", "duration"))
            this.events.filter(other => other !== added && other.position < added.complete && other.complete > position)
                .forEach(other => {
                    if (other.position >= position && other.complete <= added.complete) {
                        other.box.delete()
                    } else if (other.position < position) {
                        other.box.duration.setValue(position - other.position)
                    } else {
                        other.box.duration.setValue(other.complete - added.complete)
                        other.box.position.setValue(added.complete)
                    }
                })
            return added
        })
    }

    clearEvents(): void {this.#context.edit(() => this.events.forEach(event => event.remove()))}
}
