import {KeyEventBox, TimelineBox} from "@opendaw/studio-boxes"
import {ppqn} from "@opendaw/lib-dsp"
import {asInstanceOf, int, isDefined, UUID} from "@opendaw/lib-std"
import {Key, KeyEvent, KeyEventProps, KeyTrack} from "../../Api"
import {Context} from "../Context"
import {Facade, Props} from "../Common"
import {Fields} from "../Fields"
import {Guard} from "../Guard"

export class KeyEventImpl extends Facade<KeyEventBox> implements KeyEvent {
    static wrap(context: Context, box: KeyEventBox): KeyEventImpl {
        return context.facade(box, () => new KeyEventImpl(context, box))
    }

    declare position: ppqn
    declare root: int
    declare scale: int

    private constructor(context: Context, box: KeyEventBox) {
        super(context, box)
        this.bind({position: box.position, root: box.root, scale: box.scale})
    }
}

export class KeyTrackImpl implements KeyTrack {
    readonly #context: Context
    readonly #timelineBox: TimelineBox

    declare enabled: boolean
    declare root: int
    declare scale: int

    constructor(context: Context, timelineBox: TimelineBox) {
        this.#context = context
        this.#timelineBox = timelineBox
        const {keyTrack} = timelineBox
        Fields.bind(context, this, {enabled: keyTrack.enabled, root: keyTrack.root, scale: keyTrack.scale}, "keyTrack.")
    }

    get events(): ReadonlyArray<KeyEventImpl> {
        return this.#timelineBox.keyTrack.events.pointerHub.incoming()
            .map(({box}) => KeyEventImpl.wrap(this.#context, asInstanceOf(box, KeyEventBox)))
            .sort((a, b) => a.position - b.position)
    }

    keyAt(position: ppqn): Key {
        const validated = Guard.finite(position, "position")
        const stored: Key = Object.freeze({root: this.root, scale: this.scale})
        if (!this.enabled) {return stored}
        const event = this.events.findLast(event => event.position <= validated)
        return isDefined(event) ? Object.freeze({root: event.root, scale: event.scale}) : stored
    }

    addEvent(props?: KeyEventProps): KeyEvent {
        return this.#context.edit(() => {
            const position = Guard.int32("non-negative", props?.position ?? 0, "position")
            if (this.events.some(event => event.position === position)) {
                throw new RangeError(`position: a key change already exists at ${position}`)
            }
            const {root, scale} = this.keyAt(position)
            const box = KeyEventBox.create(this.#context.boxGraph, UUID.generate(), box => {
                box.track.refer(this.#timelineBox.keyTrack.events)
                box.position.setValue(position)
                box.root.setValue(root)
                box.scale.setValue(scale)
            })
            return Props.apply(KeyEventImpl.wrap(this.#context, box), Props.without(props, "position"))
        })
    }

    clearEvents(): void {this.#context.edit(() => this.events.forEach(event => event.remove()))}
}
